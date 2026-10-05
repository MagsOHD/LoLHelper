"""French typography fixes applied to every sentence the engine produces."""

import re
from typing import TypeVar

from pydantic import BaseModel

_ELISION = re.compile(r"\b([DdLl]e|[Ll]a|[Qq]ue|[Jj]usque) (?=[AEIOUYÉÈÊÂÎÔ])")

M = TypeVar("M")


def elide(text: str) -> str:
    """'de Amumu' -> "d'Amumu", 'que Ahri' -> "qu'Ahri" (only before capitalized vowel words)."""
    return _ELISION.sub(lambda m: m.group(1)[:-1] + "'", text)


def elide_all(value: M) -> M:
    if isinstance(value, str):
        return elide(value)  # type: ignore[return-value]
    if isinstance(value, list):
        return [elide_all(v) for v in value]  # type: ignore[return-value]
    if isinstance(value, BaseModel):
        return value.model_copy(update={k: elide_all(getattr(value, k)) for k in type(value).model_fields})
    return value
