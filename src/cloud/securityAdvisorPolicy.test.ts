import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_SECURITY_ADVISOR_WARNING,
  evaluateSecurityAdvisorFindings,
} from './securityAdvisorPolicy.mjs'

const warn = (name: string) => ({ name, level: 'WARN' })

describe('the hosted security-advisor release policy', () => {
  it('passes the one explicitly approved Free-plan warning', () => {
    const result = evaluateSecurityAdvisorFindings([warn(ACCEPTED_SECURITY_ADVISOR_WARNING)])

    expect(result.pass).toBe(true)
    expect(result.accepted).toEqual([{ name: ACCEPTED_SECURITY_ADVISOR_WARNING, level: 'WARN' }])
    expect(result.blocked).toEqual([])
  })

  it('fails an unknown warning', () => {
    expect(evaluateSecurityAdvisorFindings([warn('some_new_warning')]).pass).toBe(false)
  })

  it('fails every error', () => {
    expect(evaluateSecurityAdvisorFindings([{ name: 'advisor_error', level: 'ERROR' }]).pass).toBe(false)
  })

  it('fails when any warning accompanies the approved warning', () => {
    const result = evaluateSecurityAdvisorFindings([
      warn(ACCEPTED_SECURITY_ADVISOR_WARNING),
      warn('some_new_warning'),
    ])

    expect(result.pass).toBe(false)
    expect(
      evaluateSecurityAdvisorFindings([
        warn(ACCEPTED_SECURITY_ADVISOR_WARNING),
        warn(ACCEPTED_SECURITY_ADVISOR_WARNING),
      ]).pass,
    ).toBe(false)
  })

  it('passes with zero findings', () => {
    expect(evaluateSecurityAdvisorFindings([])).toEqual({ pass: true, accepted: [], blocked: [] })
  })
})
