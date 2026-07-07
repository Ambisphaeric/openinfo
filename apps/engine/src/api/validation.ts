import { Value } from '@sinclair/typebox/value'
import type { TSchema } from '@sinclair/typebox'
import { AllSchemas } from '@openinfo/contracts'

export const schemaByName = (name: string): TSchema | undefined =>
  Object.prototype.hasOwnProperty.call(AllSchemas, name) ? AllSchemas[name as keyof typeof AllSchemas] : undefined

export const schemaFor = schemaByName

export const validationErrors = (schemaName: string, value: unknown): string[] => {
  const schema = schemaByName(schemaName)
  if (!schema) return [`unknown schema: ${schemaName}`]
  return [...Value.Errors(schema, value)].map((error) => `${error.path}: ${error.message}`)
}

export const isValid = (schemaName: string, value: unknown): boolean => {
  const schema = schemaByName(schemaName)
  return schema ? Value.Check(schema, value) : false
}

export const assertValid = (schemaName: string, value: unknown): void => {
  if (isValid(schemaName, value)) return
  throw new Error(validationErrors(schemaName, value).join('; '))
}
