import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => cleanup());

// jsdom lacks these APIs the console touches; stub them so components render.
if (!('clipboard' in navigator)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn() },
    configurable: true,
  });
}
// URL.createObjectURL / revokeObjectURL for the evidence-bundle / CSV downloads.
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL ?? vi.fn(() => 'blob:mock');
globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL ?? vi.fn();
