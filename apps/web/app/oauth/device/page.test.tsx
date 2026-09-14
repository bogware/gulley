import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  deviceCodePreview: vi.fn(),
  approveDeviceCode: vi.fn(),
  denyDeviceCode: vi.fn(),
};
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({ useSearchParams: () => searchParams }));
vi.mock('../../../lib/admin-context', () => ({
  useAdmin: () => ({ api, authed: true, ready: true }),
}));

import DeviceConsentPage from './page';

beforeEach(() => {
  api.deviceCodePreview.mockReset();
  api.approveDeviceCode.mockReset();
  api.denyDeviceCode.mockReset();
  searchParams = new URLSearchParams();
});

describe('DeviceConsentPage', () => {
  it('pre-fills the code from ?user_code, previews the client/workspace, and approves', async () => {
    searchParams = new URLSearchParams('user_code=abcd-efgh');
    api.deviceCodePreview.mockResolvedValue({
      userCode: 'ABCD-EFGH',
      clientId: 'claude-code',
      clientName: 'Claude Code',
      orgId: 'o',
      orgName: 'Acme',
      workspaceId: 'w',
      workspaceName: 'prod',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    api.approveDeviceCode.mockResolvedValue({ approved: true });
    render(<DeviceConsentPage />);
    expect((screen.getByPlaceholderText('XXXX-XXXX') as HTMLInputElement).value).toBe('abcd-efgh');
    await waitFor(() => expect(screen.getByTestId('device-preview')).toBeInTheDocument());
    expect(screen.getByTestId('device-preview').textContent).toContain('Claude Code (claude-code)');
    expect(screen.getByTestId('device-preview').textContent).toContain('prod');
    expect(api.deviceCodePreview).toHaveBeenCalledWith('abcd-efgh');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/Approved — you can close/)).toBeInTheDocument());
    expect(api.approveDeviceCode).toHaveBeenCalledWith('abcd-efgh');
  });

  it('keeps Approve/Deny disabled until a code previews, and reports an unknown code', async () => {
    api.deviceCodePreview.mockRejectedValue(new Error('GET /oauth/device/preview → 400: {}'));
    render(<DeviceConsentPage />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('XXXX-XXXX'), { target: { value: 'ZZZZ-9999' } });
    await waitFor(() => expect(screen.getByText(/Unknown, expired/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(api.approveDeviceCode).not.toHaveBeenCalled();
  });

  it('denies', async () => {
    searchParams = new URLSearchParams('user_code=ABCD-EFGH');
    api.deviceCodePreview.mockResolvedValue({
      userCode: 'ABCD-EFGH',
      clientId: 'codex',
      clientName: 'Codex',
      orgId: 'o',
      workspaceId: 'w',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    api.denyDeviceCode.mockResolvedValue({ denied: true });
    render(<DeviceConsentPage />);
    await waitFor(() => expect(screen.getByTestId('device-preview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.getByText(/Denied — the agent/)).toBeInTheDocument());
    expect(api.denyDeviceCode).toHaveBeenCalledWith('ABCD-EFGH');
  });
});
