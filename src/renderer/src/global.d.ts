import type { BureauApi } from '../../shared/preload/api';

declare global {
  interface Window {
    bureau: BureauApi;
  }
}

export {};
