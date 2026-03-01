import { ChevronDown, ChevronRight } from "lucide-react";
import { MobileAppQRCode } from "@/client/components/MobileAppQRCode";

interface MobileAppStepProps {
  isExpanded: boolean;
  onToggle: () => void;
}

export function MobileAppStep({ isExpanded, onToggle }: MobileAppStepProps) {
  return (
    <div className="border border-base-content/20 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 hover:bg-base-200 transition-colors text-left"
      >
        <div>
          <h3 className="font-semibold">Connect mobile app</h3>
          <p className="text-sm text-base-content/70">
            Scan the QR code to connect the Every App mobile app to this gateway
          </p>
        </div>
        {isExpanded ? (
          <ChevronDown className="w-5 h-5 text-base-content/50" />
        ) : (
          <ChevronRight className="w-5 h-5 text-base-content/50" />
        )}
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 pt-2">
          <div className="bg-base-200/50 rounded-lg p-4">
            <MobileAppQRCode />
          </div>
        </div>
      )}
    </div>
  );
}
