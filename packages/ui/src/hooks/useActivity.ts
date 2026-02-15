import { useState, useEffect, useCallback } from "react";
import type { ActivityEvent, ActivityOptions } from "@seedvault/sdk";
import { useSeedvault } from "../components/SeedvaultProvider.js";

const PAGE_SIZE = 50;

export function useActivity(opts?: ActivityOptions) {
  const { client } = useSeedvault();
  const [entries, setEntries] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    client
      .getActivity({ ...opts, limit: PAGE_SIZE })
      .then(setEntries)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client, opts?.contributor, opts?.action]);

  const loadMore = useCallback(async () => {
    const more = await client.getActivity({
      ...opts,
      limit: PAGE_SIZE,
      offset: entries.length,
    });
    setEntries((prev) => [...prev, ...more]);
  }, [client, entries.length, opts]);

  return { entries, loading, loadMore };
}
