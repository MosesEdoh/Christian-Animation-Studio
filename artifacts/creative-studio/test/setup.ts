import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { activateMovieBatchAccount } from '../src/lib/movieBatchProgress';

beforeEach(() => {
  activateMovieBatchAccount(null);
  localStorage.clear();
});
afterEach(cleanup);
