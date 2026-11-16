export const PROVIDER_CONTRACT_VERSION = 'ai-img-gen.provider-contract.v1';

const DEFAULT_PROVIDER_CONTRACTS = Object.freeze([
  {
    id: 'deterministic',
    state: 'active',
    external: false,
    adapter_version: 'deterministic-provider-adapter-v1',
    models: [
      {
        id: 'deterministic-v1',
        version: '1',
        capabilities: [
          {
            name: 'prompt_compilation',
            input_modalities: ['structured'],
            structured_output: true,
            verified: true,
            contract_version: 'deterministic-prompt-compilation-v1',
          },
        ],
      },
    ],
  },
  {
    id: 'opencodex',
    state: 'disabled_pending_contract',
    external: true,
    adapter_version: 'opencodex-provider-adapter-v1',
    models: [],
  },
  {
    id: 'codex-cli',
    state: 'reserved_offline',
    external: true,
    adapter_version: 'codex-cli-offline-adapter-v1',
    models: [],
  },
]);

function clone(value) {
  return structuredClone(value);
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requestField(request, camel, snake) {
  return request?.[camel] ?? request?.[snake];
}

function normalizeCapabilityRequest(request = {}) {
  const inputModalities = requestField(request, 'inputModalities', 'input_modalities') ?? [];
  if (!Array.isArray(inputModalities)) throw new Error('inputModalities must be an array');
  return {
    provider_id: requireText(requestField(request, 'providerId', 'provider_id'), 'providerId'),
    model_id: requireText(requestField(request, 'modelId', 'model_id'), 'modelId'),
    capability: requireText(request.capability, 'capability'),
    input_modalities: [...new Set(inputModalities.map((value) => requireText(value, 'input modality')))].sort(),
    structured_output: requestField(request, 'structuredOutput', 'structured_output'),
  };
}

function contractList(contracts) {
  if (!Array.isArray(contracts)) throw new Error('provider contracts must be an array');
  const seen = new Set();
  return contracts.map((contract) => {
    const id = requireText(contract.id, 'provider id');
    if (seen.has(id)) throw new Error(`Duplicate provider contract: ${id}`);
    seen.add(id);
    return clone({ schema_version: PROVIDER_CONTRACT_VERSION, ...contract, id });
  });
}

function resolveAgainst(contracts, request) {
  const required = normalizeCapabilityRequest(request);
  const provider = contracts.find((item) => item.id === required.provider_id);
  if (!provider) throw new Error(`Exact provider contract not found: ${required.provider_id}; model substitution is forbidden`);
  if (provider.state !== 'active') {
    throw new Error(`Provider ${provider.id} is ${provider.state}; no provider or model fallback is permitted`);
  }
  const model = (provider.models || []).find((item) => item.id === required.model_id);
  if (!model) {
    throw new Error(`Exact model contract not found for ${provider.id}/${required.model_id}; model substitution is forbidden`);
  }
  const capability = (model.capabilities || []).find((item) => item.name === required.capability && item.verified === true);
  if (!capability) {
    throw new Error(`Exact capability contract not found or unverified: ${required.capability}`);
  }

  const supportedModalities = new Set(capability.input_modalities || []);
  const missingModalities = required.input_modalities.filter((item) => !supportedModalities.has(item));
  if (missingModalities.length) {
    throw new Error(`Exact capability mismatch for ${required.capability}; unsupported input modalities: ${missingModalities.join(', ')}`);
  }
  if (required.structured_output !== undefined && required.structured_output !== capability.structured_output) {
    throw new Error(`Exact capability mismatch for ${required.capability}; structured output requirement was not met`);
  }

  return clone({
    schema_version: PROVIDER_CONTRACT_VERSION,
    provider_id: provider.id,
    provider_state: provider.state,
    adapter_version: provider.adapter_version,
    model_id: model.id,
    model_version: model.version,
    capability: capability.name,
    capability_contract_version: capability.contract_version,
    input_modalities: capability.input_modalities,
    structured_output: capability.structured_output,
  });
}

export function createProviderContractRegistry({ contracts = DEFAULT_PROVIDER_CONTRACTS } = {}) {
  const normalizedContracts = contractList(contracts);
  return Object.freeze({
    statuses() {
      return normalizedContracts.map((contract) => clone(contract));
    },
    resolve(request) {
      return resolveAgainst(normalizedContracts, request);
    },
  });
}

export function resolveProviderCapability(request, { contracts = DEFAULT_PROVIDER_CONTRACTS } = {}) {
  return resolveAgainst(contractList(contracts), request);
}

function dataType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateSchemaValue(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('A valid structured response schema is required');
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} must be one of the declared enum values`);
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    throw new Error(`${path} must equal the declared constant`);
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowedTypes.some((type) => matchesType(value, type))) {
      throw new Error(`${path} expected ${allowedTypes.join(' or ')}, received ${dataType(value)}`);
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        throw new Error(`${path} missing required property: ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(`${path} has unexpected property: ${key}`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateSchemaValue(child, properties[key], `${path}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchemaValue(child, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw new Error(`${path} must contain at least ${schema.minItems} items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw new Error(`${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) throw new Error(`${path} must contain unique items`);
    }
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`));
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} expected a finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${path} must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} does not match the required pattern`);
    }
  }
}

export function validateStructuredProviderResponse(response, { schema, validator } = {}) {
  if (!schema && typeof validator !== 'function') {
    throw new Error('A structured response schema or validator is required');
  }
  let parsed;
  if (typeof response === 'string') {
    try {
      parsed = JSON.parse(response);
    } catch {
      throw new Error('Provider response must be valid JSON');
    }
  } else if (response && typeof response === 'object') {
    parsed = clone(response);
  } else {
    throw new Error('Provider response must be a JSON object or JSON string');
  }

  if (schema) validateSchemaValue(parsed, schema);
  if (typeof validator === 'function') {
    const validated = validator(parsed);
    if (validated === false || validated === undefined || validated === null) {
      throw new Error('Provider response validator rejected an invalid or incomplete payload');
    }
    return validated === true ? parsed : validated;
  }
  return parsed;
}
