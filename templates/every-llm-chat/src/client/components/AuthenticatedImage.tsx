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
        className={`animate-pulse bg-gray-200 rounded-lg flex items-center justify-center ${className}`}
      >
        <div className="text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`bg-gray-100 rounded-lg flex items-center justify-center ${className}`}
      >
        <div className="text-gray-400 text-sm">Failed to load image</div>
      </div>
    );
  }

  return <img src={imageSrc!} alt={alt} className={className} />;
}
