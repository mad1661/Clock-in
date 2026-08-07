/**
 * Cloud Functions entry point.
 *
 * Every mutation in the app is a callable here. The web client has no write
 * access to Firestore or to anything but its own photo prefix in Storage, so
 * these functions are the complete set of ways data can change.
 */
export {
  bootstrapAdmin,
  createWorker,
  updateWorker,
  setWorkerActive,
  resetWorkerPassword,
  acknowledgePasswordChange,
} from './adminUsers';

export { upsertJobSite, deleteJobSite } from './jobSites';

export { clockIn, clockOut } from './clock';

export { reviewShift, adjustShift, autoCloseStaleShifts } from './review';

export { requestShiftEdit, cancelShiftEdit, reviewShiftEdit } from './shiftEdits';

export { updateCompanySettings } from './settings';
