export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRequest {
  query: string;
  maxResults: number;
  baseUrl: string | null;
  apiKey: string | null;
  signal: AbortSignal;
}

export type SearchAdapter = (request: SearchRequest) => Promise<SearchResult[]>;
