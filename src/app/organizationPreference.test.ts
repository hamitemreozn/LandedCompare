import { describe, expect, it } from 'vitest'
import { CLOUD_SESSION_STORAGE_KEY } from '../cloud/client'
import {
  ORGANIZATION_PREFERENCE_KEY,
  parseOrganizationPreference,
  readOrganizationPreference,
  writeOrganizationPreference,
} from './organizationPreference'

const USER = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_USER = 'bbbbbbbb-0000-4000-8000-000000000001'
const ORG = '11111111-1111-4111-8111-111111111111'

class Recording implements Storage {
  readonly writes: string[] = []
  private readonly map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.get(key) ?? null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.writes.push(key); this.map.set(key, value) }
}

describe('the organisation preference', () => {
  it('is namespaced to LandedCompare and never touches the session key', () => {
    const storage = new Recording()
    storage.setItem(CLOUD_SESSION_STORAGE_KEY, '{"access_token":"x"}')
    writeOrganizationPreference(USER, ORG, storage)
    expect(ORGANIZATION_PREFERENCE_KEY).toBe('landedcompare.selectedOrganization')
    expect(ORGANIZATION_PREFERENCE_KEY).not.toBe(CLOUD_SESSION_STORAGE_KEY)
    expect(storage.getItem(CLOUD_SESSION_STORAGE_KEY)).toBe('{"access_token":"x"}')
    expect(JSON.parse(storage.getItem(ORGANIZATION_PREFERENCE_KEY)!)).toEqual({ userId: USER, organizationId: ORG })
  })

  it('stores two identifiers and nothing else', () => {
    const storage = new Recording()
    writeOrganizationPreference(USER, ORG, storage)
    expect(Object.keys(JSON.parse(storage.getItem(ORGANIZATION_PREFERENCE_KEY)!)).sort()).toEqual(['organizationId', 'userId'])
  })

  it('is read back only for the user who wrote it', () => {
    const storage = new Recording()
    writeOrganizationPreference(USER, ORG, storage)
    expect(readOrganizationPreference(USER, storage)).toBe(ORG)
    expect(readOrganizationPreference(OTHER_USER, storage)).toBeUndefined()
  })

  it('treats anything malformed as no preference', () => {
    for (const raw of [null, '', 'not json', '{}', '[]', '{"userId":"x","organizationId":"y"}', `{"userId":"${USER}"}`]) {
      expect(parseOrganizationPreference(raw)).toBeUndefined()
    }
  })

  it('writes only when the choice changes, so re-entering a company does not wake other tabs', () => {
    const storage = new Recording()
    writeOrganizationPreference(USER, ORG, storage)
    writeOrganizationPreference(USER, ORG, storage)
    expect(storage.writes).toEqual([ORGANIZATION_PREFERENCE_KEY])
  })

  it('survives storage that throws: nothing is remembered and nothing fails', () => {
    const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } } as unknown as Storage
    expect(() => writeOrganizationPreference(USER, ORG, broken)).not.toThrow()
    expect(readOrganizationPreference(USER, broken)).toBeUndefined()
  })
})
