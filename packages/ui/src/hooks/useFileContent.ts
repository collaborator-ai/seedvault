import { useState, useEffect } from "react";
import type { FileContent } from "@seedvault/sdk";
import { useSeedvault } from "../components/SeedvaultProvider.js";

export function useFileContent(path: string | null) {
  const { client } = useSeedvault();
  const [file, setFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!path) {
      setFile(null);
      return;
    }
    setLoading(true);
    setError(null);
    client
      .readFile(path)
      .then(setFile)
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err : new Error(String(err)),
        );
      })
      .finally(() => setLoading(false));
  }, [client, path]);

  return { file, loading, error };
}
