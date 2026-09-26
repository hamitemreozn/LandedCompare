/**
 * Structural shape every supported-locale resource must satisfy. `en.ts` and
 * `tr.ts` are both typed against this, so a key added to one and forgotten in
 * the other is a compile error, not just a runtime drift caught by tests.
 */
export interface TranslationResource {
  readonly common: {
    readonly appName: string
    readonly save: string
    readonly saving: string
    readonly cancel: string
    readonly delete: string
    readonly edit: string
    readonly add: string
    readonly continue: string
    readonly back: string
    readonly close: string
    readonly retry: string
    readonly loading: string
    readonly error: string
    readonly warning: string
    readonly yes: string
    readonly no: string
    readonly search: string
    readonly clear: string
    readonly actions: string
    readonly status: string
    readonly active: string
    readonly inactive: string
    readonly notes: string
    readonly unknown: string
    readonly language: string
  }
  readonly units: {
    readonly piece: string
    readonly box: string
    readonly package: string
    readonly carton: string
    readonly set: string
    readonly meter: string
    readonly kilogram: string
    readonly liter: string
  }
  readonly unitField: {
    readonly choose: string
    readonly other: string
    readonly customLabel: string
    readonly customPlaceholder: string
  }
  readonly boot: {
    readonly initializing: string
    readonly initializingHint: string
    readonly failureTitle: string
    readonly migrationBlockedTitle: string
    readonly whatToDo: string
    readonly errorCode: string
    readonly failure: {
      readonly preMigrationVersionUnknown: string
      readonly preMigrationSnapshotFailed: string
      readonly databaseOpenFailed: string
    }
    readonly warning: {
      readonly snapshotMaintenanceFailed: string
      readonly snapshotStorageOverCeiling: string
      readonly storageNotPersisted: string
    }
  }
  readonly dataError: {
    readonly environmentUnsupported: string
    readonly databaseOpenFailed: string
    readonly databaseUpgradeBlocked: string
    readonly schemaVersionTooNew: string
    readonly schemaMetadataInvalid: string
    readonly migrationFailed: string
    readonly transactionAborted: string
    readonly quotaExceeded: string
    readonly recordInvalid: string
    readonly recordNotFound: string
    readonly referenceMissing: string
    readonly staleWrite: string
    readonly appendOnlyViolation: string
    readonly duplicateKey: string
    readonly destructiveOperationRefused: string
    readonly cryptoUnavailable: string
    readonly snapshotFailed: string
    readonly snapshotInvalid: string
    readonly unexpected: string
  }
  /**
   * Cloud failures, which only exist once the data lives somewhere else.
   *
   * Separate from `dataError` rather than merged into it, because the two
   * layers answer different questions: `dataError` says what went wrong with a
   * record, and these say what went wrong with the *connection to the company's
   * data*. A user who is told "the record was refused" when the truth is "the
   * server is paused" is being sent to fix the wrong thing.
   */
  readonly cloudError: {
    readonly offline: string
    readonly serverUnavailable: string
    readonly serverUnavailableAdmin: string
    readonly sessionExpired: string
    readonly invalidCredentials: string
    readonly forbidden: string
    readonly noMembership: string
    readonly membershipDeactivated: string
    readonly organizationLocked: string
    readonly notConfigured: string
    readonly provisioningInFlight: string
    readonly unexpected: string
  }
  readonly cloudAuth: {
    readonly signInTitle: string
    readonly emailLabel: string
    readonly passwordLabel: string
    readonly signIn: string
    readonly signOut: string
    readonly noSelfServiceReset: string
    readonly mustChangePasswordTitle: string
    readonly mustChangePasswordHint: string
    readonly newPasswordLabel: string
    readonly changePassword: string
    readonly passwordForAccount: string
    readonly notMyAccount: string
  }
  readonly catalogMigration: {
    readonly title: string
    readonly body: string
    readonly counts: string
    readonly backupNotice: string
    readonly ownerRequired: string
    readonly unsupportedRecords: string
    readonly start: string
    readonly migrating: string
    readonly failed: string
    readonly failedHint: string
    readonly inspectionFailedTitle: string
    readonly inspectionFailedBody: string
    readonly reasonInvalidRecord: string
    readonly reasonConflict: string
    readonly reasonCloudNotEmpty: string
    readonly reasonVerificationFailed: string
    readonly reasonUnsupportedRecords: string
    readonly retireAction: string
    readonly retireTitle: string
    readonly retireBody: string
    readonly retireNote: string
    readonly retireConfirm: string
    readonly storeProducts: string
    readonly storeSuppliers: string
    readonly storeCustomers: string
  }
  readonly shell: {
    readonly identityLabel: string
    readonly organization: string
    readonly user: string
    readonly switchOrganization: string
    readonly previousSelectionUnavailable: string
    readonly breadcrumbLabel: string
    readonly openMenu: string
    readonly closeMenu: string
    readonly collapseSidebar: string
    readonly expandSidebar: string
    readonly accountMenu: string
  }
  readonly backupStatus: {
    readonly label: string
    readonly never: string
    readonly fresh: string
    readonly stale: string
    readonly lastExport: string
    readonly snapshotIsNotBackup: string
    readonly exportComingLater: string
  }
  readonly tabAdvisory: {
    readonly title: string
    readonly body: string
  }
  readonly nav: {
    readonly primaryLabel: string
    readonly dashboard: string
    readonly products: string
    readonly suppliers: string
    readonly customers: string
    readonly customerStatuses: string
    readonly masterData: string
    readonly operations: string
    readonly quoteAnalysis: string
    readonly purchases: string
    readonly shipments: string
    readonly inventory: string
    readonly settings: string
    readonly administration: string
    readonly organization: string
    readonly comingSoon: string
    readonly notAvailableYet: string
  }
  readonly invitationConfirmation: {
    readonly title: string
    readonly bodyInvite: string
    readonly bodyRecovery: string
    readonly warning: string
    readonly accept: string
    readonly decline: string
    readonly unknownAccount: string
    readonly checkFailedTitle: string
    readonly checkFailedBody: string
    readonly ignore: string
  }
  readonly organizationSelection: {
    readonly title: string
    readonly body: string
    readonly previousUnavailable: string
    readonly listLabel: string
    readonly roleLabel: string
  }
  readonly organization: {
    readonly title: string
    readonly subtitle: string
    readonly memberOnly: string
    readonly reload: string
    readonly info: {
      readonly title: string
      readonly name: string
      readonly id: string
      readonly yourRole: string
      readonly yourAccess: string
      readonly companies: string
    }
    readonly roles: {
      readonly OWNER: string
      readonly ADMIN: string
      readonly MEMBER: string
    }
    readonly statuses: {
      readonly ACTIVE: string
      readonly DISABLED: string
    }
    readonly members: {
      readonly title: string
      readonly name: string
      readonly email: string
      readonly role: string
      readonly status: string
      readonly you: string
      readonly noProfile: string
      readonly roleSelectLabel: string
      readonly disable: string
      readonly enable: string
      readonly confirm: string
      readonly disableTitle: string
      readonly disableBody: string
      readonly disableNote: string
      readonly enableTitle: string
      readonly enableBody: string
      readonly roleTitle: string
      readonly roleBody: string
    }
    readonly invite: {
      readonly title: string
      readonly hint: string
      readonly email: string
      readonly displayName: string
      readonly role: string
      readonly submit: string
      readonly submitting: string
      readonly invalidEmail: string
      readonly done: string
    }
    readonly attempts: {
      readonly title: string
      readonly body: string
      readonly more: string
      readonly startedAt: string
      readonly clear: string
    }
    readonly backup: {
      readonly title: string
      readonly body: string
      readonly scope: string
      readonly integrity: string
      readonly export: string
      readonly exporting: string
      readonly done: string
      readonly counts: string
      readonly failed: string
    }
  }
  readonly dashboard: {
    readonly title: string
    readonly subtitle: string
    readonly products: string
    readonly suppliers: string
    readonly customers: string
    readonly activeOfTotal: string
    readonly localData: string
    readonly database: string
    readonly schemaVersion: string
    readonly origin: string
    readonly originHint: string
    readonly storage: string
    readonly storagePersisted: string
    readonly storageNotPersisted: string
    readonly storageUnsupported: string
    readonly snapshots: string
    readonly snapshotTakenToday: string
    readonly snapshotAlreadyToday: string
    readonly snapshotUnavailable: string
    readonly recentlyUpdated: string
    readonly recordType: string
    readonly recordName: string
    readonly nothingYet: string
    readonly nothingYetHint: string
    readonly cloudData: string
    readonly organization: string
    readonly role: string
    readonly source: string
    readonly cloudAuthoritative: string
  }
  readonly list: {
    readonly searchPlaceholder: string
    readonly filterLabel: string
    readonly filterAll: string
    readonly filterActive: string
    readonly filterInactive: string
    readonly sortLabel: string
    readonly showing: string
    readonly noResults: string
    readonly noResultsHint: string
    readonly reloading: string
  }
  readonly lifecycle: {
    readonly deactivate: string
    readonly activate: string
    readonly deactivateTitle: string
    readonly deactivateBody: string
    readonly activateTitle: string
    readonly activateBody: string
    readonly notADeletion: string
    readonly changeFromList: string
  }
  readonly form: {
    readonly requiredNote: string
    readonly requiredField: string
    readonly mustBeNumber: string
    readonly ambiguousSeparator: string
    readonly mustBePositive: string
    readonly mustBeInteger: string
    readonly saveFailed: string
    readonly reloadRecord: string
    readonly newRecord: string
    readonly editRecord: string
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly product: {
    readonly title: string
    readonly subtitle: string
    readonly one: string
    readonly newProduct: string
    readonly sku: string
    readonly skuHint: string
    readonly name: string
    readonly sectionDetails: string
    readonly sectionPurchasing: string
    readonly description: string
    readonly descriptionHint: string
    readonly internalNote: string
    readonly internalNoteHint: string
    readonly stockUnit: string
    readonly stockUnitHint: string
    readonly defaultPurchaseUnit: string
    readonly defaultPurchaseUnitHint: string
    readonly unitsPerPurchaseUnit: string
    readonly unitsPerPurchaseUnitHint: string
    readonly conversionExample: string
    readonly manufacturer: string
    readonly manufacturerRef: string
    readonly emptyTitle: string
    readonly emptyBody: string
    readonly duplicateSku: string
    readonly noStockHere: string
    readonly sortByName: string
    readonly sortBySku: string
    readonly sortByUpdated: string
  }
  readonly supplier: {
    readonly supplier: string
    readonly supplierName: string
    readonly title: string
    readonly subtitle: string
    readonly newSupplier: string
    readonly externalRef: string
    readonly externalRefHint: string
    readonly emptyTitle: string
    readonly emptyBody: string
    readonly sortByName: string
    readonly sortByUpdated: string
  }
  readonly customer: {
    readonly title: string
    readonly subtitle: string
    readonly one: string
    readonly newCustomer: string
    readonly displayName: string
    readonly externalRef: string
    readonly externalRefHint: string
    readonly status: string
    readonly statusHint: string
    readonly statusUnavailable: string
    readonly noStatus: string
    readonly emptyTitle: string
    readonly emptyBody: string
    readonly notACrm: string
    readonly sortByName: string
    readonly sortByUpdated: string
  }
  readonly customerStatus: {
    readonly title: string
    readonly subtitle: string
    readonly newStatus: string
    readonly code: string
    readonly sortOrder: string
    readonly sortOrderHint: string
    readonly hint: string
    readonly emptyTitle: string
    readonly emptyBody: string
    readonly sortByOrder: string
    readonly sortByCode: string
    readonly deactivateBody: string
    readonly historicalNote: string
  }
  readonly quote: {
    readonly quote: string
    readonly currency: string
    readonly unitPrice: string
    readonly quantity: string
    readonly requiredQuantity: string
    readonly resolvedQuantity: string
    readonly excessQuantity: string
    readonly moq: string
    readonly packSize: string
  }
  readonly costs: {
    readonly freight: string
    readonly insurance: string
    readonly customsDuty: string
    readonly surcharge: string
    readonly discount: string
    readonly additionalCost: string
    readonly exchangeRate: string
  }
  readonly comparison: {
    readonly landedCost: string
    readonly lowestLandedCost: string
    readonly incompleteQuote: string
    readonly invalidQuote: string
    readonly rank: string
    readonly tied: string
    readonly comparisonUnavailable: string
    readonly suppliersCompared_one: string
    readonly suppliersCompared_other: string
  }
  readonly warnings: {
    readonly allocationUnavailable: string
  }
  readonly issues: {
    readonly missingQuote: string
    readonly emptyQuote: string
    readonly missingRequiredItems: string
    readonly duplicateQuoteItem: string
    readonly unknownRequirementReference: string
    readonly calculationError: string
  }
  readonly insights: {
    readonly noComparableSuppliers: string
    readonly onlyComparableSupplier: string
    readonly lowestCalculatedLandedCost: string
    readonly tiedLowestCalculatedLandedCost: string
    readonly lowestMerchandiseNotLowestLandedCost: string
  }
  readonly language: {
    readonly tr: string
    readonly en: string
  }
}
