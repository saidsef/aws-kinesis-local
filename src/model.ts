export interface Bounds {
  min?: number
  max?: number
}

export interface Member {
  name: string
  target: string
  required: boolean
}

export type Shape =
  | { type: 'structure', members: Member[] }
  | { type: 'union', members: Member[] }
  | { type: 'list', member: string, length?: Bounds }
  | { type: 'map', key: string, value: string, length?: Bounds }
  | { type: 'string', length?: Bounds, pattern?: string, enum?: string[] }
  | { type: 'integer' | 'long' | 'double', range?: Bounds }
  | { type: 'blob', length?: Bounds }
  | { type: 'boolean' }
  | { type: 'timestamp' }

export interface Operation {
  input: string
  output: string | null
  errors: string[]
}
