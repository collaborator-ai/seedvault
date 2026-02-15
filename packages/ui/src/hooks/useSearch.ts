import { useState, useEffect } from "react";
import type { SearchResult } from "@seedvault/sdk";
import { useSeedvault } from "../components/SeedvaultProvider.js";

export function useSearch(query: string) {
  const { client } = useSeedvault();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    client
      .search(query)
      .then(setResults)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err : new Error(String(err)),
        );
      })
      .finally(() => setLoading(false));
  }, [client, query]);

  return { results, loading, error };
}
