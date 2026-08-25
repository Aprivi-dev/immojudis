from bs4 import BeautifulSoup

from src.sources.image_candidates import html_image_candidates


def test_html_image_candidates_prefers_largest_srcset_then_lazy_original() -> None:
    soup = BeautifulSoup(
        """
        <img
          src="/photo-240.jpg"
          data-src="/photo-640.jpg"
          data-original="/photo-original.jpg"
          srcset="/photo-320.jpg 320w, /photo-1280.jpg 1280w, /photo-640.jpg 640w"
        />
        """,
        "html.parser",
    )

    assert html_image_candidates(soup.img) == [
        "/photo-1280.jpg",
        "/photo-640.jpg",
        "/photo-320.jpg",
        "/photo-original.jpg",
        "/photo-240.jpg",
    ]
