/**
 * A supplier this project is comparing quotations from. Not a CRM record —
 * no address, contact, rating, or history. Those are explicitly out of scope.
 */
export interface Supplier {
  readonly id: string
  readonly displayName: string
}

export interface CreateSupplierInput {
  id: string
  displayName: string
}

export class InvalidSupplierError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSupplierError'
  }
}

export function createSupplier(input: CreateSupplierInput): Supplier {
  if (input.id.trim() === '') {
    throw new InvalidSupplierError('Supplier id must not be empty')
  }
  if (input.displayName.trim() === '') {
    throw new InvalidSupplierError('Supplier displayName must not be empty')
  }
  return { id: input.id, displayName: input.displayName }
}
