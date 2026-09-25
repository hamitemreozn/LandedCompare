export const ACCEPTED_SECURITY_ADVISOR_WARNING: 'auth_leaked_password_protection'

export interface SecurityAdvisorFinding {
  name: string
  level: string
}

export interface BlockedSecurityAdvisorFinding extends SecurityAdvisorFinding {
  reason: string
}

export function evaluateSecurityAdvisorFindings(findings: unknown): {
  pass: boolean
  accepted: SecurityAdvisorFinding[]
  blocked: BlockedSecurityAdvisorFinding[]
}
