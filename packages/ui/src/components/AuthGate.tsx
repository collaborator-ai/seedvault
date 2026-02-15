import type React from "react";
import { useState } from "react";
import { SeedvaultClient } from "@seedvault/sdk";

interface AuthGateProps {
  baseUrl: string;
  onAuthenticated: (token: string) => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  border: "0.8px solid var(--sv-border)",
  borderRadius: "var(--sv-radius)",
  background: "var(--sv-input-bg)",
  color: "var(--sv-foreground)",
  fontFamily: "var(--sv-font-mono)",
  fontSize: "0.85rem",
  outline: "none",
  boxSizing: "border-box",
};

const buttonStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 16px",
  border: "none",
  borderRadius: "var(--sv-radius)",
  background: "var(--sv-foreground)",
  color: "var(--sv-background)",
  fontFamily: "var(--sv-font-mono)",
  fontSize: "0.85rem",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  color: "var(--sv-muted)",
  marginTop: 8,
  border: "0.8px solid var(--sv-border)",
};

export function AuthGate({
  baseUrl,
  onAuthenticated,
}: AuthGateProps) {
  const [mode, setMode] = useState<"token" | "signup">("token");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleTokenSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const client = new SeedvaultClient({ baseUrl, token });
      await client.me();
      onAuthenticated(token);
    } catch {
      setError("Invalid token");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const client = new SeedvaultClient({ baseUrl });
      const result = await client.signup(name);
      onAuthenticated(result.token);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Signup failed",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        backgroundColor: "var(--sv-background)",
        fontFamily: "var(--sv-font-sans)",
      }}
    >
      <div style={{ width: 320 }}>
        <h2
          style={{
            fontFamily: "var(--sv-font-mono)",
            fontSize: "1.1rem",
            marginBottom: 24,
            color: "var(--sv-foreground)",
          }}
        >
          seedvault
        </h2>

        {mode === "token" ? (
          <form onSubmit={handleTokenSubmit}>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sv_..."
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <button
              type="submit"
              disabled={loading || !token}
              style={buttonStyle}
            >
              {loading ? "Verifying..." : "Connect"}
            </button>
            <button
              type="button"
              onClick={() => setMode("signup")}
              style={secondaryButtonStyle}
            >
              Create account
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignup}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Username"
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <button
              type="submit"
              disabled={loading || !name}
              style={buttonStyle}
            >
              {loading ? "Creating..." : "Sign up"}
            </button>
            <button
              type="button"
              onClick={() => setMode("token")}
              style={secondaryButtonStyle}
            >
              I have a token
            </button>
          </form>
        )}

        {error && (
          <p
            style={{
              color: "var(--sv-accent-pdf)",
              fontSize: "0.85rem",
              marginTop: 12,
            }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
