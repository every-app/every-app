import { useState } from "react";
import { Send, Square, Image, X } from "lucide-react";
import { useImageUpload } from "../../hooks/useImageUpload";

interface MessageInputProps {
  onSendMessage: (message: string, imageFile?: File) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
  placeholder?: string;
}

export function MessageInput({
  onSendMessage,
  disabled = false,
  isStreaming = false,
  onStop,
  placeholder = "Ask anything about cooking...",
}: MessageInputProps) {
  const [message, setMessage] = useState("");
  const {
    selectedImage,
    imagePreview,
    fileInputRef,
    selectImage,
    removeImage,
  } = useImageUpload();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((message.trim() || selectedImage) && !disabled && !isStreaming) {
      onSendMessage(message.trim(), selectedImage || undefined);
      setMessage("");
      removeImage();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      selectImage(file);
    }
  };

  const isDisabled = disabled || isStreaming;
  const canSubmit = (message.trim() || selectedImage) && !isDisabled;

  return (
    <div className="bg-base-200 p-4 pb-safe">
      <div className="max-w-2xl mx-auto">
        {/* Image Preview */}
        {imagePreview && (
          <div className="mb-2 relative inline-block">
            <img
              src={imagePreview}
              alt="Selected"
              className="w-20 h-20 object-cover rounded-lg border border-base-300"
            />
            <button
              type="button"
              onClick={removeImage}
              className="absolute -top-2 -right-2 btn btn-circle btn-xs btn-error"
              aria-label="Remove image"
            >
              <X size={12} />
            </button>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 bg-base-100 border border-base-300 rounded-xl p-2 shadow-sm focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 transition-all"
        >
          {/* Hidden file input for image selection */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Image upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isDisabled}
            className="btn btn-ghost btn-sm btn-circle flex-shrink-0"
            aria-label="Add image"
          >
            <Image size={18} />
          </button>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? "AI is responding..." : placeholder}
            disabled={isDisabled}
            className="flex-1 resize-none min-h-[40px] max-h-[120px] bg-transparent border-none focus:outline-none placeholder:text-base-content/40 text-base md:text-sm px-2 py-2"
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="btn btn-error btn-sm btn-circle"
              aria-label="Stop generating"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSubmit}
              className="btn btn-primary btn-sm btn-circle"
              aria-label="Send message"
            >
              <Send size={16} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
