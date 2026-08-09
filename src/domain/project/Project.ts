import { parseCurrencyCode, type CurrencyCode } from '../monetary/CurrencyCode'
import type { RequirementItem } from '../requirement/RequirementItem'
import type { Supplier } from '../supplier/Supplier'
import type { Quote } from '../quote/Quote'

/**
 * The top-level container a user works within: one base currency, its
 * requirements, the suppliers being compared, and their quotes. Holds only
 * user-provided input — calculated results (landed totals, ranking) are not
 * part of this shape; they are derived by the calculation engine (Phase 2+).
 */
export interface Project {
  readonly id: string
  readonly name: string
  readonly baseCurrency: CurrencyCode
  readonly createdAt: string
  readonly updatedAt: string
  readonly requirements: readonly RequirementItem[]
  readonly suppliers: readonly Supplier[]
  readonly quotes: readonly Quote[]
}

export interface CreateProjectInput {
  id: string
  name: string
  baseCurrency: string
  createdAt: string
  updatedAt: string
  requirements?: readonly RequirementItem[]
  suppliers?: readonly Supplier[]
  quotes?: readonly Quote[]
}

export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProjectError'
  }
}

export function createProject(input: CreateProjectInput): Project {
  if (input.id.trim() === '') {
    throw new InvalidProjectError('Project id must not be empty')
  }
  if (input.name.trim() === '') {
    throw new InvalidProjectError('Project name must not be empty')
  }
  return {
    id: input.id,
    name: input.name,
    baseCurrency: parseCurrencyCode(input.baseCurrency),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    requirements: input.requirements ?? [],
    suppliers: input.suppliers ?? [],
    quotes: input.quotes ?? [],
  }
}
