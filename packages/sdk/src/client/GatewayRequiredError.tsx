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

// CSS custom properties for theming
const CSS_VARIABLES = `
  @media (prefers-color-scheme: light) {
    :root {
      --gateway-bg: oklch(100% 0 0);
      --gateway-text: oklch(0% 0 0);
      --gateway-text-muted: oklch(40% 0 0);
      --gateway-icon-bg: oklch(94% 0 0);
      --gateway-icon-stroke: oklch(80% 0.18 90);
      --gateway-border: oklch(94% 0 0);
    }
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --gateway-bg: #0a0f0d;
      --gateway-text: oklch(92% 0 0);
      --gateway-text-muted: oklch(60% 0 0);
      --gateway-icon-bg: oklch(22% 0 0);
      --gateway-icon-stroke: oklch(85% 0.18 90);
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
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
    fontWeight: 500,
    lineHeight: "24px",
    color: "rgb(168, 162, 158)",
    textDecoration: "underline",
    textDecorationColor: "rgb(87, 83, 78)",
    textUnderlineOffset: "4px",
    cursor: "pointer",
    transition:
      "color, background-color, border-color, text-decoration-color, fill, stroke 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
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
        <h1 style={styles.title}>Open in Gateway</h1>

        {/* Description */}
        <p style={styles.description}>
          The Gateway handles sign in and user auth. Access your app from there
          so this works properly.
        </p>

        {/* Redirect Link */}
        <a href={gatewayUrl} style={styles.link}>
          Go to Gateway
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </a>
      </div>
    </div>
  );
}
