import { Graph } from "./graph";

export interface Row {
  type: string;
}

export interface RowSingle extends Row {
  type: "single";
  graph: Graph;
}

export interface RowDouble extends Row {
  type: "double";
  split: "oox" | "oxx" | "ox";
  graph1: Graph;
  graph2: Graph;
}

export interface RowTriple extends Row {
  type: "triple";
  graph1: Graph;
  graph2: Graph;
  graph3: Graph;
}

// Guards
export function isSingleRow(row: Row): row is RowSingle {
  return row.type === "single";
}

export function isDoubleRow(row: Row): row is RowDouble {
  return row.type === "double";
}

export function isTripleRow(row: Row): row is RowTriple {
  return row.type === "triple";
}

export interface Dashboard {
  id: string;
  name: string;
  rows: Row[];

  streaming: boolean;
  span: number;
  time: number;
}
