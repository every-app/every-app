import { CSSProperties } from "react";

interface GatewayRequiredErrorProps {
  /**
   * The origin of the Gateway (e.g., "https://gateway.example.com").
   */
  gatewayOrigin: string;
  /**
   * The app ID used in the Gateway URL path.
   */
  appId: string;
}

// Button gradient styles
const BUTTON_GRADIENT =
  "linear-gradient(180deg, #424242 0%, #353535 50%, #2a2a2a 100%)";
const BUTTON_GRADIENT_HOVER =
  "linear-gradient(180deg, #4d4d4d 0%, #404040 50%, #353535 100%)";

// CSS custom properties for theming
const CSS_VARIABLES = `
  @media (prefers-color-scheme: light) {
    :root {
      --gateway-bg: oklch(100% 0 0);
      --gateway-text: oklch(0% 0 0);
      --gateway-text-muted: oklch(40% 0 0);
      --gateway-icon-bg: oklch(94% 0 0);
      --gateway-icon-stroke: oklch(55% 0.22 25);
      --gateway-border: oklch(94% 0 0);
    }
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --gateway-bg: #0a0f0d;
      --gateway-text: oklch(92% 0 0);
      --gateway-text-muted: oklch(60% 0 0);
      --gateway-icon-bg: oklch(22% 0 0);
      --gateway-icon-stroke: oklch(65% 0.2 25);
      --gateway-border: oklch(30% 0 0);
    }
  }
`;

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "24px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
    backgroundColor: "var(--gateway-bg, oklch(100% 0 0))",
    color: "var(--gateway-text, oklch(0% 0 0))",
    colorScheme: "light dark",
  } satisfies CSSProperties,
  content: {
    maxWidth: "380px",
    width: "100%",
    textAlign: "left",
  } satisfies CSSProperties,
  iconContainer: {
    width: "44px",
    height: "44px",
    marginBottom: "16px",
    borderRadius: "0.25rem",
    backgroundColor: "var(--gateway-icon-bg, oklch(94% 0 0))",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--gateway-border, oklch(94% 0 0))",
  } satisfies CSSProperties,
  title: {
    fontSize: "18px",
    fontWeight: 600,
    marginBottom: "8px",
    color: "var(--gateway-text, oklch(0% 0 0))",
    letterSpacing: "-0.01em",
  } satisfies CSSProperties,
  description: {
    fontSize: "14px",
    lineHeight: 1.5,
    color: "var(--gateway-text-muted, oklch(40% 0 0))",
    marginBottom: "20px",
  } satisfies CSSProperties,
  button: {
    display: "inline-block",
    padding: "10px 20px",
    fontSize: "14px",
    fontWeight: 500,
    color: "#ffffff",
    background: BUTTON_GRADIENT,
    borderRadius: "0.25rem",
    textDecoration: "none",
    border: "none",
  } satisfies CSSProperties,
};

/**
 * Error component displayed when an embedded app is accessed directly
 * instead of through the Every App Gateway.
 *
 * This component informs users that authentication requires accessing
 * the app through the Gateway and provides a link to do so.
 */
export function GatewayRequiredError({
  gatewayOrigin,
  appId,
}: GatewayRequiredErrorProps) {
  const displayName = appId || "This app";
  const gatewayUrl = `${gatewayOrigin}/apps/${appId}${window.location.pathname}`;

  return (
    <div style={styles.container}>
      <style>{CSS_VARIABLES}</style>
      <div style={styles.content}>
        {/* Warning Icon */}
        <div style={styles.iconContainer}>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--gateway-icon-stroke, oklch(55% 0.22 25))"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        {/* Title */}
        <h1 style={styles.title}>Gateway Required</h1>

        {/* Description */}
        <p style={styles.description}>
          {displayName} needs to be accessed through the Gateway for
          authentication to work properly.
        </p>

        {/* Redirect Link/Button - Metallic style */}
        <a
          href={gatewayUrl}
          style={styles.button}
          onMouseOver={(e) => {
            e.currentTarget.style.background = BUTTON_GRADIENT_HOVER;
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = BUTTON_GRADIENT;
          }}
        >
          Open in Gateway
        </a>
      </div>
    </div>
  );
}
