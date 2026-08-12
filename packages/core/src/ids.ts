// Branded ID types stop org/workspace/project/principal IDs from being silently
// interchanged. They carry no runtime cost — the brand exists only at type level.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type OrgId = Brand<string, 'OrgId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type PrincipalId = Brand<string, 'PrincipalId'>;
export type VirtualKeyId = Brand<string, 'VirtualKeyId'>;

export const asOrgId = (v: string): OrgId => v as OrgId;
export const asWorkspaceId = (v: string): WorkspaceId => v as WorkspaceId;
export const asProjectId = (v: string): ProjectId => v as ProjectId;
export const asPrincipalId = (v: string): PrincipalId => v as PrincipalId;
export const asVirtualKeyId = (v: string): VirtualKeyId => v as VirtualKeyId;
