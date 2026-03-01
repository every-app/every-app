import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";

interface MobileAppQRCodeProps {
  size?: number;
}

export function MobileAppQRCode({ size = 140 }: MobileAppQRCodeProps) {
  const deepLinkUrl = useMemo(() => {
    const origin =
      typeof window === "undefined"
        ? "https://your-gateway.example.com"
        : window.location.origin;
    return `everyapp://connect?gateway=${encodeURIComponent(origin)}`;
  }, []);

  return (
    <div className="space-y-2">
      <div className="bg-white p-3 rounded-lg w-fit">
        <QRCodeSVG value={deepLinkUrl} size={size} level="M" />
      </div>
      <p className="text-xs text-base-content/50">
        Scan with your phone to connect the Every App mobile app to this
        gateway.
      </p>
    </div>
  );
}
