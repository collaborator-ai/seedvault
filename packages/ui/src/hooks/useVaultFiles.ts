import { useState, useEffect, useCallback } from "react";
import type { FileEntry } from "@seedvault/sdk";
import { useSeedvault } from "../components/SeedvaultProvider.js";

export function useVaultFiles(prefix?: string) {
  const { client } = useSeedvault();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.listFiles(prefix);
      setFiles(result);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      setLoading(false);
    }
  }, [client, prefix]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { files, loading, error, refresh };
}
