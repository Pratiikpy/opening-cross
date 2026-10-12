import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only cleans up on its own when the test framework exposes globals.
afterEach(() => cleanup());
