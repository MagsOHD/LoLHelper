from app.engine.text import elide


def test_elides_before_vowel_names():
    assert elide("l'engage de Amumu") == "l'engage d'Amumu"
    assert elide("avant que Ahri ait ses objets") == "avant qu'Ahri ait ses objets"
    assert elide("la Orianna") == "l'Orianna"


def test_keeps_consonants_and_lowercase_words():
    assert elide("les dégâts de Jinx") == "les dégâts de Jinx"
    assert elide("de une à deux") == "de une à deux"
