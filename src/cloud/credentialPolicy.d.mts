export type CredentialKind =
  | 'PUBLISHABLE'
  | 'LEGACY_ANON_JWT'
  | 'SECRET'
  | 'PRIVILEGED_JWT'
  | 'MALFORMED_JWT'
  | 'UNRECOGNIZED'

export interface CredentialClassification {
  readonly kind: CredentialKind
  readonly role?: string
}

export interface PrivilegedCredentialHit {
  readonly kind: 'SECRET' | 'PRIVILEGED_JWT'
  readonly role?: string
}

export function jwtRole(token: string): string | undefined
export function classifyCredential(value: string): CredentialClassification
export function isClientCredential(value: string, options?: { readonly allowLegacyAnon?: boolean }): boolean
export function findPrivilegedCredentials(text: string): PrivilegedCredentialHit[]
