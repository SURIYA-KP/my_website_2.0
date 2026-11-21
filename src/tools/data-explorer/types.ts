// Shared data model for Data Explorer. Data is stored column-wise for speed:
//   integer / float / date  -> Float64Array (NaN = missing; dates are UTC epoch ms)
//   boolean                 -> Uint8Array (0 = false, 1 = true, 255 = missing)
//   string                  -> (string | null)[]

export type ColType = 'integer' | 'float' | 'boolean' | 'date' | 'string';

export const BOOL_NULL = 255;

export interface Column {
  name: string;
  type: ColType;
  data: Float64Array | Uint8Array | (string | null)[];
  /** Date columns: true when at least one value carries a time of day. */
  hasTime?: boolean;
}

export interface DatasetMeta {
  format?: 'csv' | 'json' | 'sql' | 'sample';
  delimiter?: string;
  bytes?: number;
  warnings?: string[];
  decimalComma?: boolean;
}

export interface Dataset {
  name: string;
  columns: Column[];
  rowCount: number;
  meta: DatasetMeta;
}

export const TYPE_LABEL: Record<ColType, string> = {
  integer: 'Integer',
  float: 'Decimal',
  boolean: 'Boolean',
  date: 'Date',
  string: 'Text',
};

export const TYPE_ICON: Record<ColType, string> = {
  integer: '#',
  float: '.#',
  boolean: '◐',
  date: '◷',
  string: 'Aa',
};

export function isNumericType(t: ColType) {
  return t === 'integer' || t === 'float';
}
