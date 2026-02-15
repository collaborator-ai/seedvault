import { useState, useEffect, useMemo, useCallback } from "react";
import { SeedvaultClient } from "@seedvault/sdk";
import {
  SeedvaultProvider,
  VaultTable,
  FileViewer,
  AuthGate,
  useSeedvault,
  useVaultFiles,
  useFileContent,
  useVaultEvents,
} from "@seedvault/ui";

const STORAGE_KEY_TOKEN = "sv-token";
const STORAGE_KEY_FILE = "sv-file";

export function App() {
  const [token, setToken] = useState<string | null>(
    localStorage.getItem(STORAGE_KEY_TOKEN),
  );

  const client = useMemo(() => {
    if (!token) return null;
    return new SeedvaultClient({
      baseUrl: window.location.origin,
      token,
    });
  }, [token]);

  if (!client) {
    return (
      <AuthGate
        baseUrl={window.location.origin}
        onAuthenticated={(t) => {
          localStorage.setItem(STORAGE_KEY_TOKEN, t);
          setToken(t);
        }}
      />
    );
  }

  return (
    <SeedvaultProvider client={client}>
      <VaultApp />
    </SeedvaultProvider>
  );
}

function VaultApp() {
  const { client } = useSeedvault();
  const [selectedPath, setSelectedPath] = useState<
    string | null
  >(localStorage.getItem(STORAGE_KEY_FILE));
  const [username, setUsername] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client
      .me()
      .then((me) => setUsername(me.username))
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load user",
        );
      });
  }, [client]);

  const handleSelectPath = useCallback(
    (path: string | null) => {
      setSelectedPath(path);
      if (path) {
        localStorage.setItem(STORAGE_KEY_FILE, path);
      } else {
        localStorage.removeItem(STORAGE_KEY_FILE);
      }
    },
    [],
  );

  const prefix = username ? `${username}/` : undefined;
  const { files, refresh } = useVaultFiles(prefix);
  const { file } = useFileContent(selectedPath);

  useVaultEvents(() => {
    refresh();
  });

  if (error) {
    return (
      <p style={{ color: "var(--sv-error)", padding: 24 }}>
        {error}
      </p>
    );
  }

  if (!username) {
    return (
      <p style={{ color: "var(--sv-muted)", padding: 24 }}>
        Loading...
      </p>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        backgroundColor: "var(--sv-background)",
        color: "var(--sv-foreground)",
      }}
    >
      <div
        style={{
          width: 320,
          borderRight: "0.8px solid var(--sv-border)",
          overflowY: "auto",
        }}
      >
        <VaultTable
          files={files}
          selectedPath={selectedPath ?? undefined}
          onSelect={handleSelectPath}
        />
      </div>
      <div
        style={{ flex: 1, overflowY: "auto", padding: 24 }}
      >
        {file ? (
          <FileViewer content={file.content} />
        ) : (
          <p style={{ color: "var(--sv-muted)" }}>
            Select a file
          </p>
        )}
      </div>
    </div>
  );
}
