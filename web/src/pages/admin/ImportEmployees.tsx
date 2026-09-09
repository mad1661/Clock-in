import { useRef, useState } from 'react';
import { createWorker } from '../../lib/actions';
import { errorMessage } from '../../lib/errors';
import { TEMPLATE_COLUMNS, parseRoster, type RosterRow } from '../../lib/roster';
import { Banner, Modal } from '../../components/ui';

// Avoids 0/O and 1/l/I, which get misread off a screen and mistyped on a phone.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function makePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

export interface IssuedCredential {
  displayName: string;
  email: string;
  password: string;
}

interface Failure {
  row: RosterRow;
  message: string;
}

/**
 * Brings the whole crew on at once from a spreadsheet.
 *
 * The office already has everyone's details in Excel, so the flow meets them
 * there: download a template, fill it in, upload it back. Nothing is written
 * until the sheet has been read back to them as a preview — creating thirty
 * logins is not something to do on a guess about which column was which.
 *
 * Accounts are created one at a time with the same code path as adding one
 * person by hand; a row that fails (say, an email already registered to some
 * other Firebase project user) is reported and the rest carry on. Passwords
 * are generated here and shown ONCE, with a CSV to download, because they are
 * never stored anywhere.
 */
export function ImportEmployees({
  existingEmails,
  onClose,
}: {
  existingEmails: string[];
  onClose: () => void;
}) {
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [created, setCreated] = useState<IssuedCredential[] | null>(null);
  const [failed, setFailed] = useState<Failure[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const ready = (roster ?? []).filter((r) => r.status === 'ready');

  async function downloadTemplate() {
    setError(null);
    try {
      const XLSX = await import('xlsx');
      const sheet = XLSX.utils.aoa_to_sheet([
        [...TEMPLATE_COLUMNS],
        ['Pat Doyle', 'pat@example.com', 'worker', '38.50'],
        ['Dana Reid', 'dana@example.com', 'admin', ''],
      ]);
      sheet['!cols'] = [{ wch: 26 }, { wch: 32 }, { wch: 22 }, { wch: 16 }];
      const help = XLSX.utils.aoa_to_sheet([
        ['How to fill this in'],
        [],
        ['One row per employee. The two rows already there are examples — replace them.'],
        ['Full name and Email are required; the email becomes their username.'],
        ['Role is "worker" or "admin". Leave it blank for worker.'],
        ['Hourly wage is optional and never appears on a customer ticket.'],
        [],
        ['Job sites and usual machines are assigned afterwards, by editing the'],
        ['employee under Workers. Leaving sites unassigned allows every site.'],
        [],
        ['When it is filled in, upload this file back on the Workers page.'],
      ]);
      help['!cols'] = [{ wch: 78 }];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Employees');
      XLSX.utils.book_append_sheet(book, help, 'How to fill this in');
      XLSX.writeFile(book, 'employee-import.xlsx');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function readFile(file: File) {
    setError(null);
    try {
      const XLSX = await import('xlsx');
      const book = XLSX.read(await file.arrayBuffer());
      const sheet = book.Sheets[book.SheetNames[0]];
      // raw:false reads what Excel displays, so a wage typed as a number and
      // one typed as text arrive the same way.
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false }) as unknown[][];
      const parsed = parseRoster(rows, existingEmails);
      if (parsed.length === 0) {
        setError('The sheet has headings but no employees under them.');
        return;
      }
      setRoster(parsed);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      // Same file, chosen again after fixing it in Excel, must fire onChange.
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function createAll() {
    setBusy(true);
    setError(null);
    const issued: IssuedCredential[] = [];
    const problems: Failure[] = [];
    let done = 0;
    for (const row of ready) {
      const password = makePassword();
      try {
        await createWorker({
          email: row.email,
          displayName: row.name,
          role: row.role,
          jobSiteIds: [],
          equipmentIds: [],
          password,
          hourlyRate: row.hourlyRate,
        });
        issued.push({ displayName: row.name, email: row.email, password });
      } catch (err) {
        problems.push({ row, message: errorMessage(err) });
      }
      setProgress(++done);
    }
    setCreated(issued);
    setFailed(problems);
    setBusy(false);
  }

  function downloadCredentials() {
    if (!created) return;
    const rows = [
      ['Name', 'Email (username)', 'One-time password'],
      ...created.map((c) => [c.displayName, c.email, c.password]),
    ];
    const csv = rows
      .map((row) =>
        row
          // A leading =, +, - or @ makes a spreadsheet treat the cell as a
          // formula, so prefix those with a quote.
          .map((cell) => {
            const safe = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
            return `"${safe.replace(/"/g, '""')}"`;
          })
          .join(','),
      )
      .join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'employee-passwords.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusPill = (row: RosterRow) => {
    switch (row.status) {
      case 'ready':
        return <span className="pill pill-success">Will be created</span>;
      case 'error':
        return <span className="pill pill-error">{row.problem}</span>;
      default:
        return <span className="pill pill-muted">Skipped — {row.problem}</span>;
    }
  };

  return (
    <Modal title="Import employees from Excel" onClose={busy ? () => undefined : onClose}>
      {error && <Banner kind="error">{error}</Banner>}

      {created ? (
        <>
          <Banner kind="warning" title="Passwords are shown once">
            Download the list now and hand each person theirs. Nothing is emailed, and the
            passwords are not stored anywhere — a lost one is fixed with a reset link from the
            Workers page.
          </Banner>
          <p style={{ marginBottom: 0 }}>
            <strong>{created.length}</strong> account{created.length === 1 ? '' : 's'} created.
            Everyone must change their password when they first sign in.
          </p>
          <ul className="list">
            {created.map((c) => (
              <li key={c.email} className="row">
                <div className="row-head">
                  <span className="title">{c.displayName}</span>
                  <span className="mono">{c.password}</span>
                </div>
                <div className="row-meta">
                  <span className="mono">{c.email}</span>
                </div>
              </li>
            ))}
          </ul>
          {failed.length > 0 && (
            <Banner kind="error" title={`${failed.length} not created`}>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {failed.map((f) => (
                  <li key={f.row.line}>
                    Row {f.row.line} — {f.row.email}: {f.message}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
          <button
            type="button"
            className="primary block"
            style={{ marginTop: '0.9rem' }}
            onClick={downloadCredentials}
            disabled={created.length === 0}
          >
            Download the password list (CSV)
          </button>
          <button type="button" className="block" style={{ marginTop: '0.6rem' }} onClick={onClose}>
            Done
          </button>
        </>
      ) : roster ? (
        <>
          <p style={{ marginTop: 0 }}>
            <strong>{ready.length}</strong> of {roster.length} row
            {roster.length === 1 ? '' : 's'} will become accounts. Nothing is created until you
            say so.
          </p>
          <ul className="list">
            {roster.map((row) => (
              <li key={row.line} className="row">
                <div className="row-head">
                  <span className="title">{row.name || `Row ${row.line}`}</span>
                  {statusPill(row)}
                </div>
                <div className="row-meta">
                  <span className="mono">{row.email || '—'}</span>
                  <span>{row.role === 'admin' ? 'Administrator' : 'Worker'}</span>
                  {row.hourlyRate != null && <span>${row.hourlyRate.toFixed(2)}/h</span>}
                </div>
              </li>
            ))}
          </ul>
          {busy && (
            <p role="status">
              Creating account {progress} of {ready.length}… keep this open.
            </p>
          )}
          <button
            type="button"
            className="primary block"
            disabled={busy || ready.length === 0}
            onClick={() => void createAll()}
          >
            {busy
              ? 'Creating…'
              : `Create ${ready.length} account${ready.length === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="block"
            style={{ marginTop: '0.6rem' }}
            disabled={busy}
            onClick={() => setRoster(null)}
          >
            Choose a different file
          </button>
          <p className="hint">
            Rows with a problem are left out; fix them in Excel and upload the file again —
            people already created are skipped, so re-uploading is safe.
          </p>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>
            Fill the template in Excel — one row per employee — then upload it back here. You
            will see exactly what will be created before anything happens.
          </p>
          <button type="button" className="block" onClick={() => void downloadTemplate()}>
            ⬇ Download the template (.xlsx)
          </button>
          <div className="field" style={{ marginTop: '0.9rem' }}>
            <label htmlFor="w-import">Upload the filled-in sheet</label>
            <input
              id="w-import"
              ref={fileInput}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </div>
          <p className="hint">
            Excel (.xlsx, .xls) or CSV. Job sites and usual machines are assigned afterwards by
            editing each person — or leave sites unassigned to allow every site.
          </p>
        </>
      )}
    </Modal>
  );
}
