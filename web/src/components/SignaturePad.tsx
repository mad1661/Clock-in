import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A signature, captured as strokes rather than a picture.
 *
 * There is no Cloud Storage on this plan, so a signature has to live inside the
 * ticket document — and a Firestore document is capped at 1 MiB. Stroke paths
 * come to a few kilobytes where a PNG of the same signature is tens, and they
 * stay sharp when the ticket is printed, which a 600px bitmap does not.
 *
 * Coordinates are in a fixed 600×200 space regardless of the size of the pad on
 * screen, so a signature drawn on a phone renders identically on a printed page.
 */
export interface SignatureStrokes {
  paths: string[];
  width: number;
  height: number;
}

export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 200;

/** Renders a captured signature. Used on screen and on the printed ticket. */
export function SignatureMark({ signature }: { signature: SignatureStrokes }) {
  return (
    <svg
      className="signature-mark"
      viewBox={`0 0 ${signature.width} ${signature.height}`}
      preserveAspectRatio="xMinYMax meet"
      role="img"
      aria-label="Supervisor signature"
    >
      {signature.paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export function SignaturePad({
  onChange,
}: {
  onChange: (signature: SignatureStrokes | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<Array<Array<[number, number]>>>([]);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale((canvas.width / SIGNATURE_WIDTH) * 1, (canvas.height / SIGNATURE_HEIGHT) * 1);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';

    for (const stroke of strokes.current) {
      if (stroke.length === 1) {
        // A single tap is a dot, and dots are part of signatures.
        ctx.beginPath();
        ctx.arc(stroke[0][0], stroke[0][1], 1.5, 0, Math.PI * 2);
        ctx.fillStyle = '#111';
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(stroke[0][0], stroke[0][1]);
      for (let i = 1; i < stroke.length - 1; i++) {
        // Curve through the midpoints, so a signature reads as handwriting
        // rather than as the polyline the pointer events actually gave us.
        const [x, y] = stroke[i];
        const [nx, ny] = stroke[i + 1];
        ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      ctx.lineTo(stroke[stroke.length - 1][0], stroke[stroke.length - 1][1]);
      ctx.stroke();
    }
    void ratio;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      redraw();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [redraw]);

  /** Pointer position in the fixed 600×200 signature space. */
  function at(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * SIGNATURE_WIDTH,
      ((e.clientY - rect.top) / rect.height) * SIGNATURE_HEIGHT,
    ];
  }

  function toStrokes(): SignatureStrokes | null {
    const paths = strokes.current
      .filter((s) => s.length > 0)
      .map((stroke) => {
        const r = (n: number) => Math.round(n * 10) / 10;
        if (stroke.length === 1) {
          const [x, y] = stroke[0];
          return `M ${r(x)} ${r(y)} l 0.1 0`;
        }
        let d = `M ${r(stroke[0][0])} ${r(stroke[0][1])}`;
        for (let i = 1; i < stroke.length - 1; i++) {
          const [x, y] = stroke[i];
          const [nx, ny] = stroke[i + 1];
          d += ` Q ${r(x)} ${r(y)} ${r((x + nx) / 2)} ${r((y + ny) / 2)}`;
        }
        const last = stroke[stroke.length - 1];
        d += ` L ${r(last[0])} ${r(last[1])}`;
        return d;
      });
    return paths.length ? { paths, width: SIGNATURE_WIDTH, height: SIGNATURE_HEIGHT } : null;
  }

  function begin(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([at(e)]);
    setEmpty(false);
    redraw();
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    e.preventDefault();
    const stroke = strokes.current[strokes.current.length - 1];
    const point = at(e);
    const previous = stroke[stroke.length - 1];
    // Drop points the pen barely moved between: fewer points, same signature,
    // and a document that stays small.
    if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1.5) return;
    stroke.push(point);
    redraw();
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(toStrokes());
  }

  function clear() {
    strokes.current = [];
    setEmpty(true);
    onChange(null);
    redraw();
  }

  return (
    <div className="sig-pad-wrap">
      <canvas
        ref={canvasRef}
        className="sig-pad"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        aria-label="Sign here"
      />
      <div className="sig-pad-foot">
        <span className="hint">{empty ? 'Sign above with your finger or a stylus' : ' '}</span>
        <button type="button" className="small" onClick={clear} disabled={empty}>
          Clear
        </button>
      </div>
    </div>
  );
}
