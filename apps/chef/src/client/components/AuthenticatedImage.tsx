import { useAuthenticatedImage } from "../hooks/useAuthenticatedImage";

interface AuthenticatedImageProps {
  imageKey: string;
  alt?: string;
  className?: string;
}

export function AuthenticatedImage({
  imageKey,
  alt = "Image",
  className,
}: AuthenticatedImageProps) {
  const { imageSrc, loading, error } = useAuthenticatedImage(imageKey);

  if (loading) {
    return (
      <div
        className={`animate-pulse bg-base-300 rounded-lg flex items-center justify-center ${className}`}
      >
        <div className="text-base-content/50 text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`bg-base-200 rounded-lg flex items-center justify-center ${className}`}
      >
        <div className="text-base-content/50 text-sm">Failed to load image</div>
      </div>
    );
  }

  if (!imageSrc) {
    return null;
  }

  return <img src={imageSrc} alt={alt} className={className} />;
}
