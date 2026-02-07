/**
 * DM notification manager (shared Slack implementation).
 */

export {
  sendDmNotification,
  clearDmDebounce,
  truncateQueryForPreview,
  DM_DEBOUNCE_MS,
} from '../../slack/dist/dm-notifications.js';

