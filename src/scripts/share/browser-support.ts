import type { ConfirmationCopy } from './local-access';

export function browserCryptoUnavailableCopy(): ConfirmationCopy {
  return {
    button: 'Copy link',
    detail: [
      'This browser cannot run RMUX end-to-end encryption.',
      'Open this link in an up-to-date Chrome, Edge, or Firefox, then retry.',
    ].join(' '),
    title: 'Browser encryption unavailable',
    local: false,
    action: 'copy-link',
  };
}
