import { useState, useEffect, useMemo } from "react";
import { SeedvaultClient } from "@seedvault/sdk";
import {
  SeedvaultProvider,
  VaultTable,
  FileViewer,
  AuthGate,
  useSeedvault,
  useVaultFiles,
  useFileContent,
} from "@seedvault/ui";

export function App() {
  const [token, setToken] = useState<string | null>(
    localStorage.getItem("sv-token"),
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
          localStorage.setItem("sv-token", t);
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
  const client = useSeedvault();
  const [selectedPath, setSelectedPath] = useState<
    string | null
  >(null);
  const [username, setUsername] = useState<string | null>(
    null,
  );

  useEffect(() => {
    client.me().then((me) => setUsername(me.username));
  }, [client]);

  const prefix = username ? `${username}/` : undefined;
  const { files } = useVaultFiles(prefix);
  const { file } = useFileContent(selectedPath);

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
          onSelect={setSelectedPath}
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
