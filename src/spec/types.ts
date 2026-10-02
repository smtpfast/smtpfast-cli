export type ValueType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ParamSpec {
  /** Name as the API knows it. */
  name: string;
  /** CLI flag without the leading dashes. Unused for path params. */
  flag: string;
  in: "path" | "query" | "header" | "body";
  type: ValueType;
  /** Item type when type is "array". */
  items?: ValueType;
  required: boolean;
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
  example?: string;
  nullable?: boolean;
}

export interface BodySpec {
  required: boolean;
  contentType: string;
  /** "unknown" when the schema has no usable shape; only --data works then. */
  type: "object" | "array" | "unknown";
  fields: ParamSpec[];
}

export interface OperationSpec {
  operationId: string;
  method: HttpMethod;
  path: string;
  group: string;
  command: string;
  summary: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  /** True when the spec declares an Idempotency-Key header for this operation. */
  idempotencyKey?: boolean;
  pathParams: ParamSpec[];
  queryParams: ParamSpec[];
  headerParams: ParamSpec[];
  body: BodySpec | null;
}

export interface GroupSpec {
  name: string;
  description: string;
}

export interface Manifest {
  manifestVersion: 1;
  specTitle: string;
  specVersion: string;
  /** sha256 of the canonical JSON of the spec this manifest was built from. */
  specHash: string;
  operationCount: number;
  groups: GroupSpec[];
  operations: OperationSpec[];
}

export interface BuildWarning {
  operation: string;
  message: string;
}

/** Loose OpenAPI shapes. The generator only trusts what it checks. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
