import { useEffect, useRef, useState } from "react";
import type { VaultEvent } from "@seedvault/sdk";
import { useSeedvault } from "../components/SeedvaultProvider.js";

export function useVaultEvents(
  onEvent?: (event: VaultEvent) => void,
) {
  const { client } = useSeedvault();
  const [latestEvent, setLatestEvent] = useState<VaultEvent | null>(
    null,
  );
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        for await (const event of client.subscribe({
          signal: controller.signal,
        })) {
          setLatestEvent(event);
          callbackRef.current?.(event);
        }
      } catch {
        // aborted or connection closed
      }
    })();

    return () => controller.abort();
  }, [client]);

  return latestEvent;
}
