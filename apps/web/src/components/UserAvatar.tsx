"use client";

import { useMemo, useState } from "react";

type AvatarSize = "xxs" | "xs" | "md";

interface UserAvatarProps {
  name: string;
  image?: string | null;
  fallbackTextClassName: string;
  className?: string;
  size: AvatarSize;
}

const SIZES_CLASS: Record<AvatarSize, string> = {
  xxs: "w-6 h-6 min-w-6 min-h-6",
  xs: "w-8 h-8 min-w-8 min-h-8",
  md: "w-24 h-24 min-w-24 min-h-24",
};

function normalizeGoogleAvatarUrl(imageUrl: string): string {
  // Google often returns tiny avatar variants like `...=s96-c`.
  // Request a larger square to keep it crisp in all avatar sizes.
  return imageUrl.replace(/=s\d+-c$/, "=s256-c");
}

export function UserAvatar({
  name,
  image,
  fallbackTextClassName,
  className = "",
  size = "md",
}: UserAvatarProps) {
  const [hasError, setHasError] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || "U";
  const preparedImage = useMemo(() => {
    if (!image) return null;
    if (image.includes("googleusercontent.com")) {
      return normalizeGoogleAvatarUrl(image);
    }
    return image;
  }, [image]);

  const sizeClassName = SIZES_CLASS[size] || SIZES_CLASS["md"];

  const showImage = Boolean(preparedImage) && !hasError;

  return (
    <div
      className={`${sizeClassName} relative rounded-full overflow-hidden flex-shrink-0 ${className}`.trim()}
    >
      {showImage ? (
        <img
          src={preparedImage as string}
          alt={name}
          className={`block ${sizeClassName} object-cover object-center`}
          referrerPolicy="no-referrer"
          onError={() => setHasError(true)}
        />
      ) : (
        <div className="absolute inset-0 bg-primary flex items-center justify-center">
          <span className={`${fallbackTextClassName} text-primary-foreground`}>
            {initial}
          </span>
        </div>
      )}
    </div>
  );
}
