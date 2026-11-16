"""stdin original image -> metadata-free, uncropped JPEG on stdout."""
import io
import sys
import warnings

from PIL import Image, ImageOps

MAX_INPUT_BYTES = 20 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not raw or len(raw) > MAX_INPUT_BYTES:
        raise ValueError("image input exceeds size limit")
    with Image.open(io.BytesIO(raw)) as original:
        if original.format not in {"JPEG", "PNG", "WEBP"}:
            raise ValueError("unsupported image format")
        if getattr(original, "n_frames", 1) != 1:
            raise ValueError("animated images are unsupported")
        original.load()
        image = ImageOps.exif_transpose(original)
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        # Fresh canvas prevents EXIF, ICC, comments and other info propagation.
        clean = Image.new("RGB", image.size, "white")
        if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
            rgba = image.convert("RGBA")
            clean.paste(rgba, mask=rgba.getchannel("A"))
        else:
            clean.paste(image.convert("RGB"))
        clean.save(sys.stdout.buffer, format="JPEG", quality=88, optimize=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("image thumbnail rejected: invalid, unsupported or oversized image", file=sys.stderr)
        sys.exit(1)
