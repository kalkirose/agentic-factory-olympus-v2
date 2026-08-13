// File contracts: a seat's final act writes its JSON report to the path the
// orchestrator names; a deterministic process validates it here. Schemas are
// a flat draft-07-safe subset — every construct below validates identically
// under any draft-07 validator, and `checkReportSchema` rejects everything
// outside the subset, so validation stays deterministic and owned.
//
// The subset: a top-level object with primitive fields, arrays of
// primitives, arrays of flat objects, or one level of flat object; `enum` on
// primitives; explicit `additionalProperties` on every object level (the
// draft-07 default is open — an explicit boolean keeps behavior identical
// across validators).
import { readFileSync } from 'node:fs';

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean']);
const OBJECT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'description']);
const PROPERTY_KEYS = new Set([
  'type',
  'enum',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'description',
]);

/**
 * Checks that a schema stays inside the flat draft-07-safe subset. Returns
 * `{path, message}` errors; empty means the schema is usable.
 */
export function checkReportSchema(schema) {
  const errors = [];
  checkObjectSchema(schema, '$', errors, { nested: false });
  return errors;
}

function checkObjectSchema(schema, path, errors, { nested }) {
  if (!isPlainObject(schema)) {
    errors.push({ path, message: 'schema must be an object' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!OBJECT_KEYS.has(key)) errors.push({ path, message: `unsupported keyword: ${key}` });
  }
  if (schema.type !== 'object') errors.push({ path, message: 'type must be "object"' });
  if (typeof schema.additionalProperties !== 'boolean') {
    errors.push({ path, message: 'additionalProperties must be an explicit boolean' });
  }
  if (!isPlainObject(schema.properties)) {
    errors.push({ path, message: 'properties must be an object' });
    return;
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    checkPropertySchema(prop, `${path}.${name}`, errors, { nested });
  }
  if (schema.required !== undefined) {
    const ok =
      Array.isArray(schema.required) &&
      schema.required.every((k) => typeof k === 'string' && k in schema.properties);
    if (!ok) errors.push({ path, message: 'required must list defined property names' });
  }
}

function checkPropertySchema(prop, path, errors, { nested }) {
  if (!isPlainObject(prop)) {
    errors.push({ path, message: 'property schema must be an object' });
    return;
  }
  for (const key of Object.keys(prop)) {
    if (!PROPERTY_KEYS.has(key)) errors.push({ path, message: `unsupported keyword: ${key}` });
  }
  if (PRIMITIVES.has(prop.type)) {
    if (prop.enum !== undefined && (!Array.isArray(prop.enum) || prop.enum.length === 0)) {
      errors.push({ path, message: 'enum must be a non-empty array' });
    }
    return;
  }
  if (prop.type === 'array') {
    if (!isPlainObject(prop.items)) {
      errors.push({ path, message: 'array requires an items schema' });
      return;
    }
    if (prop.items.type === 'object') {
      if (nested) errors.push({ path, message: 'objects nest at most one level' });
      else checkObjectSchema(prop.items, `${path}[]`, errors, { nested: true });
    } else if (PRIMITIVES.has(prop.items.type)) {
      checkPropertySchema(prop.items, `${path}[]`, errors, { nested: true });
    } else {
      errors.push({ path: `${path}[]`, message: 'array items must be primitives or flat objects' });
    }
    return;
  }
  if (prop.type === 'object') {
    if (nested) errors.push({ path, message: 'objects nest at most one level' });
    else checkObjectSchema(prop, path, errors, { nested: true });
    return;
  }
  errors.push({ path, message: `unsupported type: ${prop.type}` });
}

/**
 * Validates a report value against a subset schema (shape-checked first).
 * Returns `{path, message}` errors; empty means the report is valid.
 */
export function validateReport(schema, value) {
  const errors = [];
  validateObject(schema, value, '$', errors);
  return errors;
}

function validateObject(schema, value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push({ path: `${path}.${key}`, message: 'required field missing' });
  }
  for (const [key, v] of Object.entries(value)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'unknown field' });
      }
      continue;
    }
    validateValue(prop, v, `${path}.${key}`, errors);
  }
}

function validateValue(prop, value, path, errors) {
  if (prop.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, message: 'must be an array' });
      return;
    }
    value.forEach((item, i) => validateValue(prop.items, item, `${path}[${i}]`, errors));
    return;
  }
  if (prop.type === 'object') {
    validateObject(prop, value, path, errors);
    return;
  }
  if (!typeOk(prop.type, value)) {
    errors.push({ path, message: `must be a ${prop.type}` });
    return;
  }
  if (prop.enum !== undefined && !prop.enum.includes(value)) {
    errors.push({ path, message: `must be one of: ${prop.enum.join(', ')}` });
  }
}

function typeOk(type, value) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

/**
 * Reads a report file. A missing or unparsable file is a validation failure
 * with the same error shape, so the corrective route treats it uniformly.
 * `missing` marks the one case the corrective brief words differently: the
 * seat wrote nothing at all, so the brief names that cause.
 * @returns {{value: object} |
 *   {errors: Array<{path: string, message: string}>, missing?: boolean}}
 */
export function readReport(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { missing: true, errors: [{ path: '$', message: `no report file at ${path}` }] };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { errors: [{ path: '$', message: 'report is not valid JSON' }] };
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
