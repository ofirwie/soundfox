import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  // Next 16: dev HMR is blocked when accessing via 127.0.0.1 (needed for Spotify OAuth)
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.scdn.co", pathname: "/image/**" },
      { protocol: "https", hostname: "mosaic.scdn.co" },
      { protocol: "https", hostname: "profile-images.scdn.co" },
      { protocol: "https", hostname: "image-cdn-ak.spotifycdn.com" },
      { protocol: "https", hostname: "image-cdn-fa.spotifycdn.com" },
    ],
  },
};
export default nextConfig;
