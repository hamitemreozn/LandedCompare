import type { Database } from '../database'
import type { TransactionScope } from '../idb'
import { parseSettingRecord, type SettingRecord, type SettingValue } from '../records/settings'

export async function readSettingRecord(
  scope: TransactionScope,
  key: string,
): Promise<SettingRecord | undefined> {
  const stored = await scope.get<unknown>('settings', key)
  return stored === undefined ? undefined : parseSettingRecord(stored)
}

export function readSetting(database: Database, key: string): Promise<SettingRecord | undefined> {
  return database.read(['settings'], (scope) => readSettingRecord(scope, key))
}

export function readAllSettings(database: Database): Promise<SettingRecord[]> {
  return database.read(['settings'], async (scope) => {
    const stored = await scope.getAll<unknown>('settings')
    return stored.map((record, index) => parseSettingRecord(record, `settings[${index}]`))
  })
}

// `async` so a validation failure is a rejection like every other failure in
// this layer, rather than a synchronous throw the caller has to handle twice.
export async function writeSetting(
  database: Database,
  key: string,
  value: SettingValue,
): Promise<void> {
  // Validated before the transaction opens, not after — a record that cannot
  // be read back should never have been written in the first place.
  const record = parseSettingRecord({ key, value })
  await database.write(['settings'], (scope) => scope.put('settings', record))
}

export function deleteSetting(database: Database, key: string): Promise<void> {
  return database.write(['settings'], (scope) => scope.delete('settings', key))
}
