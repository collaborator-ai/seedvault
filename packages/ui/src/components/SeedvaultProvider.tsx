import { createContext, useContext, type ReactNode } from "react";
import { SeedvaultClient } from "@seedvault/sdk";

interface SeedvaultContextValue {
  client: SeedvaultClient;
}

const SeedvaultContext = createContext<SeedvaultContextValue | null>(null);

interface SeedvaultProviderProps {
  client: SeedvaultClient;
  children: ReactNode;
}

export function SeedvaultProvider({ client, children }: SeedvaultProviderProps) {
  return (
    <SeedvaultContext.Provider value={{ client }}>
      {children}
    </SeedvaultContext.Provider>
  );
}

export function useSeedvault(): SeedvaultContextValue {
  const ctx = useContext(SeedvaultContext);
  if (!ctx) {
    throw new Error("useSeedvault must be used within a SeedvaultProvider");
  }
  return ctx;
}
