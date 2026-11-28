// Écran de chargement. Son animation est entièrement en CSS (transformations et opacité,
// voir index.html) : le navigateur la joue hors du fil principal, elle reste donc fluide
// même pendant un calcul. L'avancement n'est qu'un changement d'échelle de la barre.
//
// Il est opaque : rien de la scène ne se voit pendant qu'on la reconstruit ou qu'on la
// recompile (pièces à moitié montées, matières pas encore prêtes, image figée).

const LABELS = {
  model: 'Écriture de la chorégraphie',
  machines: 'Montage des machines',
  shaders: 'Préparation des lumières et des matières',
  scène: 'Mise en place de la scène',
  quality: 'Réglage de l’image',
};

export class Loader {
  constructor(root = document.getElementById('loader')) {
    this.root = root;
    this.bar = root.querySelector('.loader-bar > div');
    this.text = root.querySelector('.loader-text');
    this.title = root.querySelector('.loader-title');
    this.value = 0;
  }

  /**
   * Affiche l'écran et attend qu'il soit à l'image : le travail qui suit peut alors tenir
   * le fil principal sans que la scène à moitié prête n'apparaisse.
   * @param title titre affiché (nom du morceau, ou rien : inchangé)
   * @param step première étape annoncée
   */
  async show(title, step) {
    this.value = 0;
    if (LABELS[step]) this.text.textContent = LABELS[step];
    this.bar.style.transform = 'scaleX(0)';
    if (title !== undefined) this.title.textContent = title || 'Animusic';
    const wasShown = !this.root.classList.contains('done');
    this.root.classList.remove('done');
    this.root.setAttribute('aria-busy', 'true');
    if (wasShown) return;
    // Deux images : la première pose l'écran, la seconde garantit qu'il est affiché.
    // Délai de secours : un onglet en arrière-plan ne dessine pas.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
      setTimeout(resolve, 250);
    });
  }

  /** Avancement (0 à 1, jamais en arrière) et étape en cours. */
  progress(fraction, step) {
    this.value = Math.max(this.value, Math.min(1, fraction));
    this.bar.style.transform = `scaleX(${this.value.toFixed(3)})`;
    const label = LABELS[step];
    if (label && this.text.textContent !== label) this.text.textContent = label;
  }

  /** Écran affiché (il l'est au démarrage, jusqu'à la fin du premier chargement). */
  get shown() {
    return !this.root.classList.contains('done');
  }

  hide() {
    this.bar.style.transform = 'scaleX(1)';
    this.root.classList.add('done');
    this.root.setAttribute('aria-busy', 'false');
  }
}
