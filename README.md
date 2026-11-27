# Animusic — prototype

![Aperçu](docs/apercu.png)

Génère une scène 3D animée dans l'esprit d'*Animusic* (Pipe Dream) à partir d'un fichier MIDI :
des canons tirent des billes qui retombent pile sur des lames de marimba puis
reviennent à la tourelle par des tubes de verre, des bras robotisés jouent la batterie, des médiators pincent des
cordes de basse et de guitare, des archets frottent une cage de cordes, des cors et des flûtes soufflent, des tubes d'orgue s'illuminent sur les notes tenues, des
marteaux font sonner un carillon de cloches tubulaires, une harpe laser tire un rayon par note vers un cristal
et un clavier mécanique enfonce ses touches tout seul. Les instruments sortent du sol à leur entrée, l'éclairage
change à chaque section et un réalisateur filme le tout comme un concert.

**En ligne : https://drschizzo.github.io/animusic/** (déployé automatiquement par GitHub Actions).

## Utilisation

- Glisse un `.mid` sur la page (ou « Ouvrir… ») ; une démo se charge au démarrage.
- **Playlist** : glisse (ou ouvre) plusieurs `.mid` à la fois ; les morceaux s'enchaînent, un clic en choisit un,
  « Ajouter… » en ajoute, × en retire ; avec « Lecture en boucle », la playlist reprend au premier morceau.
- **Ou un enregistrement** (`.mp3`, `.wav`, `.ogg`, `.flac`…) : il est transcrit dans le navigateur (rien n'est
  envoyé nulle part), puis la scène est animée **sur le vrai son** ; un sélecteur permet d'écouter la transcription.
- Chaque piste reçoit automatiquement un instrument (**Billes**, **Basse**, **Orgue**, **Carillon**,
  **Harpe laser**, **Cordes frottées**, **Clavier**, **Batterie**), modifiable dans la liste des pistes, ou **Masquée**.
  Une piste qu'on n'entend pas (volume quasi nul, ou doublure couverte par une piste plus forte
  d'au moins 10 dB, comme des cordes lentes sous un piano) passe en **Son seul** : jouée, sans instrument à l'écran.
  Plusieurs pistes peuvent partager le même instrument.
- **Style** : *Tout en billes* (tous les instruments sont joués par des billes crachées par des tuyaux, sauf les
  cordes frottées, qui gardent leurs archets) ou *Bras et mécanismes* (bras robotisés, comme avant).
- **Caméra** : *Réalisateur* (plans automatiques), *Orbite*, ou *Libre* (souris). Toucher la vue passe en libre.
- **Barre de lecture** pour naviguer dans le morceau ; **Retard image** pour corriger une latence audio mal
  annoncée (Bluetooth) ; **Qualité** *Auto* part de *Haute* (reflets du sol, ombres portées, lumière indirecte, occlusion ambiante, flou de mouvement, profondeur de champ, faisceaux dans la brume, halo) et descend d'un cran
  si l'animation rame.
- **Sons réalistes** : lecteur SoundFont (SpessaSynth) avec la banque General MIDI *MuseScore General* : boucles, couches de vélocité, pédale de sustain, pitch bend, volume, panoramique et autres contrôleurs du fichier MIDI. Sinon synthèse.
- **⏺ Vidéo** : rejoue le morceau et l'enregistre (image + son) en MP4 ou WebM.
- **⇩ Blender** : exporte l'animation complète en glTF (`.glb`).

## Développement

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires (chorégraphie, instruments, arrangeur, réalisateur)
npm run build && npm run smoke   # build + test de fumée dans Chromium (à lancer à la main avant de pousser : la CI ne le fait plus)
npm run bench -- morceau.mid     # banc d'essai : arrangement, NaN, coût par image
npm run collide -- morceau.mid   # interpénétrations (dans les deux styles) : billes, instruments, encombrements
```

**Prototype WebGPU** (évaluation de la migration, `src/gpu.js`) : ajouter à l'adresse
`?webgpu` (WebGPURenderer, WebGPU ou repli WebGL 2), `?webgpu&webgl2` (repli WebGL 2 forcé),
`?webgpu&planar` (reflet planaire du sol au lieu des reflets en espace écran) ou `?raw`
(moteur WebGL actuel, scène brute : matériaux, lumières, ombres, sans post-traitement ni
reflets). En WebGPU, toute la scène est en nœuds TSL (`src/nodes.js`) et la chaîne d'effets
aussi (`src/postfxNodes.js`), avec des modules de three-advanced-techniques copiés dans
`src/vendor/` (TAAU, occlusion XeGTAO, reflets en espace écran, préfiltrage de la sonde).
Ces modes affichent en bas le moteur utilisé et le temps processeur de rendu par image.

## Principe : l'animation à l'envers

Comme dans MIDImotion (l'outil d'Animusic), rien n'est simulé : tout est **calculé à l'avance à partir des notes**,
puis la scène est posée à l'instant `t` lu sur l'horloge audio.

- **Billes** : une note = une bille. Tir à `t − T`, vitesse initiale `v0 = (cible − départ + ½·g·T²·ŷ) / T` →
  parabole exacte ; le canon le plus proche et libre vise juste avant de tirer, et tremble après le coup. Après sa
  lame, la bille saute dans une **gouttière** en arc, roule jusqu'à un entonnoir et revient à la tourelle par un
  **tube de verre**.
- **Batterie** : un bras à deux segments par élément, pose de frappe par cinématique inverse ; la baguette se lève
  avant le coup (plus haut si le coup est fort et espacé) et touche la peau pile à l'instant de la note, puis fouette
  (ressort amorti). La peau vibre selon ses premiers modes propres, orientés par le point de frappe.
- **Batterie à billes** (style *Tout en billes*, `src/ballistics.js`) : chaque élément a sa **station**, un seul
  tuyau dont un bout est une crosse qui crache la bille et l'autre un cornet qui l'avale. La bille frappe la peau à
  l'instant de la note, rebondit (réflexion, restitution 0,55) et retombe dans le cornet ; la grosse caisse, peau
  verticale, est frappée par une bille lancée du sol. Toutes les billes d'une station suivent la même trajectoire :
  leur écart horizontal reste égal à `vitesse × écart des notes`, d'où l'écart minimal (60 ms) en deçà duquel une
  frappe ne reçoit pas de bille. Le moteur est générique (cible, normale, vitesse d'impact → bouche, rebond, cornet)
  et servira aux autres instruments.
- **Carillon et cordes à billes** (`src/ballRow.js`) : une rampe porte une buse par cloche ou par corde, un
  collecteur porte un cornet sous chacune, et les deux sont reliés par un coude : un seul circuit. La bille frappe
  la face avant du tube (ou la corde), rebondit vers le public et tombe dans son cornet. Les trajectoires sont
  dans des plans parallèles : les billes de deux cibles voisines ne peuvent pas se croiser.
- **Clavier à billes** : la bille tombe sur la touche, qui s'enfonce à l'impact et actionne son marteau ; elle
  rebondit vers l'avant dans un cornet. Blanches et noires sont frappées à des profondeurs différentes (deux rangées
  de cornets), mais toutes les buses sortent d'une même rampe, chacune orientée pour cela.
- **Notes tenues à billes** (orgue, vents, harpe laser) : une bille ne tient pas un son, alors elle tombe dans une
  **coupelle à poussoir** ; son poids ouvre la valve, la soupape ou l'iris tant qu'elle y repose, puis le poussoir
  remonte d'un coup sec et l'éjecte vers un cornet à la fin de la note.
- **Une seule machine** (`src/trunks.js`) : du pied de la tourelle du marimba part un réseau de **tapis roulants**
  posés au sol, tracé sur une grille comme un circuit imprimé : de longs tronçons droits, parallèles ou
  perpendiculaires au bord de scène, des coudes arrondis, des faisceaux. Ils passent sous les billes du marimba,
  entre ses pieds, suivent les allées entre les gradins et finissent au pied de l'estrade de leur instrument ; la
  bille plonge alors dans le sol et ressort par une colonne de verre plantée dans l'estrade, jusqu'à la rampe
  (alimentation) ou depuis le collecteur (retour). Le tracé contourne tout ce qui est posé au sol (grille de 16 cm,
  A* où un coude coûte cher) ; deux tapis n'occupent jamais la même case, donc ne se croisent pas. Dans ce style,
  tous les instruments sont en place dès le début, les allées sont plus larges (1,5 m) pour laisser passer les
  tapis, et les estrades sont rangées en lignes droites face au public (et non en arc).
- **La vie d'une bille sur un tapis d'alimentation** : elle tombe **brute** (acier nu) d'un distributeur, au départ
  du tapis derrière la tourelle, passe dans une **cabine de peinture** qui la teint de la couleur de sa piste (les
  pots sur le toit sont les couleurs de la ligne, les hublots s'allument de la couleur qu'on peint), puis roule à
  2 m/s jusqu'au bout du tapis. Elle y arrive en avance et attend dans une **file**, contre une **porte
  d'échappement** : un cliquet de laiton qui se lève et lâche les billes une à une, chacune à l'instant exact où
  elle doit partir pour être tirée à temps. Arrêtée, une bille glisse sur la bande (tapis d'accumulation) ; la
  position de chacune ne dépend que de l'instant et de celle de devant, donc tout reste calculable à n'importe
  quel instant. Sur le tapis, les billes arrivent dans l'ordre des notes : un passage dense se lit d'avance, en
  paquet serré. Au retour, la bille, peinte, tombe du collecteur sur un tapis qui la ramène à la tourelle.
- **Calibrage et recyclage** : une bille brute sort du distributeur un peu trop grosse ; juste après, une
  **calibreuse** (meule qui tourne au-dessus de la bande, étincelles à chaque passage) la ramène à la taille de son
  instrument, puis la cabine la peint. Au bout d'un tapis de retour, la bille plonge dans un **bac de décapage**
  (bain vert, bulles) où elle perd sa couleur en coulant ; une vis la sort du bac et une **goulotte** de verre la
  porte en haut de la **colonne de réserve** du distributeur voisin (l'alimentation du même instrument). Dans cette
  colonne de verre, la pile de billes brutes se lit comme un niveau : billes rentrées moins billes servies, plus un
  stock de départ juste suffisant pour ne jamais manquer.
- **D'où vient l'énergie** : rien ne monte ni ne roule tout seul.
  - Dans chaque colonne d'alimentation, une **vis d'Archimède sans âme** (une spirale d'acier qui tourne autour de la
    bille) la monte de l'estrade jusqu'à la rampe, à 1,2 m/s ; son moteur est au pied de la colonne.
  - Les tapis sont entraînés par un **arbre de transmission** couché entre la rangée des départs et la tourelle :
    une poulie et une courroie de cuir par tapis, jusqu'à son rouleau de tête.
  - Au bout de l'arbre, une **machine à vapeur** : volant à six bras, manivelle, bielle, crosse sur ses glissières,
    cylindre de laiton et **régulateur à boules** (Watt). Ses boules tournent et s'affaissent quand la machine peine
    (beaucoup de billes lâchées par les portes à la fois), puis se relèvent : la charge se calcule d'après les
    instants de lâcher. Sans place pour la machine (marimba étroit, beaucoup de lignes), un moteur électrique à
    ailettes, posé devant l'arbre, l'entraîne par courroie.
  - À côté de la machine, le **réservoir d'air** des canons de la tourelle : son manomètre, tourné vers le public,
    baisse à chaque tir et remonte quand le compresseur a rattrapé.
- **Construction des machines** (`src/machineKit.js`) : pièces tournées chanfreinées, boîtes aux arêtes adoucies,
  longerons en caisson extrudés le long des tapis, boulonnerie, paliers à semelle, poulies à bras ; fonte laquée
  vert machine, acier usiné, laiton, cuir, douelles de bois. Chaque arbre est porté par ses paliers et chaque
  mouvement a sa transmission (courroie, renvoi, levier) ; tout est fusionné par matière.
- **Échanges de billes** (`src/passes.js`) : par moments (le début d'une section sur deux), un **canon de passe**
  dressé derrière un instrument tire la bille d'une note de l'instrument situé derrière lui, d'un long lob ; à
  défaut de voisin bien placé, c'est le canon central de la tourelle du marimba qui tire, à travers toute la scène.
  Les billes de passe laissent une traînée lumineuse, pour se lire de loin. Une passe peut aussi tomber dans une
  coupelle (la batterie tire vers l'orgue, la tourelle vers les vents ou la harpe laser). Le tube
  ou la corde visés étant cylindriques, le point d'impact est choisi (trois inconnues, résolues par Newton) pour que
  le rebond retombe dans le cornet habituel de la cible. Une passe remplace le tir de la buse : une note, une bille.
- **Basse** : des chariots glissent devant la corde suivante pendant que le médiator est au repos, puis il traverse
  la corde à l'instant exact (aller, puis retour au coup suivant) ; la corde vibre avec un flou de mouvement. Les
  chariots se balancent en s'arrêtant. Les cordes pincées (guitare, shamisen…) utilisent le même mécanisme, plus petit,
  sur un châssis en bois.
- **Vents** : un tuyau par hauteur. La soupape (piston d'un cor, buse d'une flûte de Pan) s'actionne juste avant la
  note, l'air passe pendant toute sa durée et sort, visible, du pavillon ou du haut du tuyau.
- **Cordes frottées** : cordes tendues sur le pourtour d'une cage circulaire (sommets en spirale) ; trois archets
  tournent chacun sur leur anneau, se posent sur la corde juste avant la note et la frottent pendant toute sa durée,
  en tirant et poussant alternativement (un archet tangent au cercle ne touche qu'une corde).
- **Orgue** : la valve s'ouvre avant la note, la colonne de lumière dure autant que la note.
- **Carillon** : un marteau par cloche recule puis frappe le haut du tube à l'instant de la note ; la cloche se
  balance ensuite comme un pendule amorti (somme des réponses aux frappes récentes, donc sans à-coup).
- **Harpe laser** : l'iris de l'émetteur s'ouvre avant la note, le rayon dure autant qu'elle ; le cristal brille
  de la somme des rayons reçus et éclaire réellement la scène.
- **Clavier** : la touche s'enfonce juste avant la note et remonte avant d'être rejouée ; derrière, un marteau
  frappe une lame vibrante par touche jouée. La **pédale de sustain** (CC64) est visible : pédale au sol, tringle et
  barre d'étouffoirs qui s'écarte des lames ; elles vibrent (et le son tient) jusqu'à ce qu'elle remonte.
- **Expression** : le pitch bend courbe les rayons de la harpe laser, la modulation (CC1) les fait onduler et fait
  respirer la vibration des cordes frottées et le souffle des vents ; la vélocité dose le recul des canons et la hauteur des baguettes.
- **Mouvements secondaires** (`springSum`, `src/util.js`) : chaque geste secondaire est une somme de réponses
  d'oscillateurs amortis aux événements de la partition, nulle à l'instant de chaque impulsion : rien n'est simulé,
  tout reste calculable à n'importe quel instant (saut dans la barre de lecture, export).
- **Structure** (`src/sections.js`) : le morceau est découpé en sections par la nouveauté de l'activité des
  instruments (avant / après). Un instrument qui entre tard **sort du sol** (trappe lumineuse) avant sa première
  note, puis reste en place, comme un musicien d'orchestre qui se tait. Chaque section a sa palette (horizon, bordure,
  projecteurs) et son énergie ; une tête de projecteur sur deux suit l'instrument le plus actif.
- **Réalisateur** : la liste des plans est calculée pour tout le morceau. Le sujet de chaque plan est la voix
  qu'on écoute : la **mélodie** (ligne la plus aiguë et la plus chantante, peu d'accords), un instrument qui entre ou
  qui répond, un break de batterie ; la basse et l'orgue ne sont filmés que seuls, et un instrument qui joue sans
  avoir été montré depuis longtemps finit par l'être. Un plan dure une phrase et finit avec elle. Deux instruments
  voisins qui se répondent sont cadrés ensemble (**dialogue**). Les plans alternent plans larges, rapprochés,
  contre-plongées, travellings, grues et **poursuites** d'une bille d'un rebond à l'autre ; un instrument qui entre
  est cadré pendant qu'il sort du sol. En qualité haute, la **mise au point** suit le sujet (profondeur de champ).
  **Partage de l'écran** : chaque instrument a droit à un temps d'écran en rapport avec ce qu'il joue (un
  instrument joué par des billes compte autant qu'une voix mélodique) ; celui qui en a reçu moins que sa part passe
  devant, et jamais plus de deux plans de suite sur le même sujet s'il y a quelqu'un d'autre à montrer.
  **Passage d'un plan à l'autre** : la caméra ne glisse que vers un cadrage voisin (moins de 7 m, visée proche), en
  prenant son temps ; sinon on coupe, sur un temps fort, comme une régie qui passe d'une caméra à une autre. Une
  poursuite se filme de derrière la tourelle, dans l'axe du tir.
- **Inserts sur les machines** (style *Tout en billes*) : de temps en temps, un plan court (2,5 à 3,5 s, calé sur un
  temps fort, coupe franche à l'entrée et à la sortie) montre une machine du réseau : la porte d'échappement ou la
  cabine de peinture du tapis qui alimente l'instrument qu'on écoute, ou la machine à vapeur. C'est rare : au moins
  six plans d'instruments et trente secondes entre deux inserts, jamais sur une entrée d'instrument, et pas à chaque
  occasion ; les instruments restent les vedettes. Ces plans ne comptent pas dans le temps d'écran des instruments.
- **Caméra portée** : chaque plan a son bougé, dérive lente façon steadicam pour les plans larges, travellings et
  grues, tremblement fin façon caméra à l'épaule pour les plans rapprochés et les poursuites ; la rotation autour
  du sujet démarre et s'achève en douceur.
- **Performances** : les pièces fixes de chaque instrument sont fusionnées par matériau (`src/freeze.js`) ; les
  lampes des instruments sont confiées à 4 lumières réelles, toujours présentes (pas de recompilation des shaders
  quand un instrument entre) ; une image de rodage, à la construction de la scène, envoie tout au GPU.
- **Rien ne se traverse** : chaque instrument déclare son encombrement (`SEATS`, `src/arranger.js`) ; la caméra
  survole un instrument dont elle approche (rampe douce) et choisit un angle d'où le sujet n'est pas masqué. Les
  billes rebondissent assez haut pour franchir le bout de leur lame et le bord de la gouttière, tombent dans
  l'entonnoir par son axe, roulent au centre du tube de verre et disparaissent dans un chargeur opaque.
  `tools/collide.mjs` construit la scène hors navigateur et le vérifie (billes contre toutes les pièces solides,
  surfaces de deux instruments qui se croisent, encombrement réel ≤ encombrement déclaré, pièces mobiles comprises).

## Disposition : un amphithéâtre d'orchestre

L'arc de lames et la tourelle des billes occupent le centre ; les autres instruments sont assis sur des **gradins**
derrière, tournés vers le public, chaque gradin plus haut que le précédent pour qu'on voie chaque instrument
par-dessus ceux de devant :

- gradin 1 (estrade 0,45 m) : les voix mélodiques, la plus basse au centre (vents), cordes pincées à droite, cordes
  frottées à gauche comme dans un orchestre, harpe laser ;
- gradin 2 (1,35 m) : la **section rythmique** au centre, batterie puis basse ;
- gradin 3 (2,25 m) : les instruments hauts du fond (orgue, carillon) ;
- le clavier reste au premier plan, devant la tourelle.

Chaque gradin commence juste derrière le précédent, d'après l'encombrement réel de ses instruments ; un instrument
qui ne trouve pas de place passe au gradin suivant.

## Répartition automatique des pistes

Principe : **une partie musicale = un instrument visible**, dont le mécanisme correspond au timbre (on frappe une
marimba, on pince une guitare, on frotte un violon, on souffle dans un cor). Chaque piste reçoit son propre
instrument (`groupParts`, `src/arranger.js`) ; seules la batterie (un kit) et les billes (un arc de lames, chaque
piste y garde sa couleur) réunissent plusieurs pistes, ainsi que les pistes doublées (même programme). Au-delà de
10 instruments, les plus petites parties rejoignent la plus grosse de même type. Au sol, un liseré dans la couleur
de la piste identifie chaque instrument et s'avive quand il joue.

La famille du programme General MIDI décide du mécanisme, les statistiques des notes corrigent :

| Instrument | Pistes concernées |
|---|---|
| Batterie | canal de percussion |
| Basse | basses (32-39), violoncelle / contrebasse monodiques, toute ligne grave monodique |
| Billes (marimba) | marimba, xylophone, tympanon, timbales, percussions accordées ; et toujours une partie fournie : si la leur est maigre (ou absente), la meilleure partie de clavier, carillon ou cordes pincées (à défaut un riff de synthé ou de vents en notes brèves) les rejoint |
| Carillon | célesta, glockenspiel, boîte à musique, vibraphone, cloches tubulaires, kalimba |
| Clavier | pianos, clavecin, clavinet |
| Cordes pincées | guitares, harpe, pizzicato, sitar, banjo, shamisen, koto |
| Cordes frottées | violon, alto, violoncelle, ensembles de cordes en ligne |
| Vents | cuivres (cors dorés, piston enfoncé pendant la note), anches (corps noir, pavillon argenté), flûtes (flûte de Pan soufflée par une buse) ; le souffle sort du pavillon dans la couleur de la piste |
| Orgue | orgues, chœurs, nappes, ensembles de cordes en accords |
| Harpe laser | leads de synthé (un son électronique, un rayon) |

## Rendu

- **Lieu** : une conque de scène en lattes de noyer ferme l'image derrière l'orchestre ; une rampe à son pied la
  lèche dans les teintes de la section. Au-dessus, un gril de perches porte le pont circulaire des projecteurs
  (poutre triangulée, suspendue par élingues). La caméra libre reste dans le lieu.
- **Plancher** : lames peintes filant vers le public, chacune avec sa nuance et son poli, usure par plaques. Il
  reflète la scène par un rendu miroir à demi-résolution, puis une pyramide de flous gaussiens (quatre niveaux) entre
  lesquels il interpole selon sa rugosité : un reflet satiné, sans effet de blocs.
- **Lumière** : une lumière d'ensemble faible et deux **poursuites** à ombres portées, accrochées au pont, qui
  visent les instruments les plus actifs et montent quand ils jouent. Chaque section a un blanc de poursuite et un
  seul accent ; les couleurs vives restent aux notes (couleurs de piste). Les liserés des socles ne s'allument que
  quand l'instrument joue. Les poursuites ont un bord très fondu et montent en un instant plutôt que d'un coup.
- **Reflets des lampes** (`src/materials.js`) : les lumières de three.js sont des points, dont le reflet sur un métal
  poli est une tête d'épingle démesurée. Pour les lampes seulement (pas pour les reflets du décor), la rugosité a un
  minimum (0,3, la taille d'une vraie lentille) et le reflet une échelle (0,55) : un projecteur éclaire une machine
  franchement sans allumer chaque tube d'acier comme un néon.
- **Halo** (`src/postfx.js`) : seuil progressif (on garde l'excès au-dessus du seuil, raccordé en douceur), moyenne
  pondérée sur quatre échantillons qui éteint les points chauds isolés, et compression des valeurs extrêmes. Le halo
  revient aux vraies sources : lentilles, anneaux des buses, rayons, liserés.
- **Faisceaux dans la brume**, `src/volumetric.js` : en qualité haute, le rayon de vue de chaque pixel (au quart de
  la résolution) est coupé exactement par le cône de chaque projecteur ; les poursuites y lisent leur carte d'ombres.
  En qualité moyenne, des cônes lumineux les remplacent.
- **Sonde de reflets dynamique** : une caméra à six faces, au-dessus du centre de la scène, filme en continu ce qui
  l'entoure ; l'image, préfiltrée par niveaux de rugosité, sert d'environnement à tous les matériaux. Les chromes et
  les cuivres reflètent donc la scène réelle (l'orgue ou le laser qui s'allument), et plus un décor fixe. Une face
  par image, décor fixe en qualité basse.
- **Lumière indirecte et occlusion ambiante (SSGI)**, `src/ssgi.js` : en qualité haute, la lumière visible à l'écran
  éclaire les surfaces voisines (flaque verte au pied de l'orgue, lames qui teintent leurs résonateurs…). Un tampon
  géométrique (normales, couleur de base, vitesse, profondeur) est rendu une fois ; à demi-résolution, six rayons par
  pixel marchent dans la profondeur et récoltent la lumière de l'image, et un rayon arrêté tout près de son départ
  compte comme occlusion. Limite inhérente : seul ce qui est à l'écran éclaire. La lumière indirecte est débrayable
  (case *Lumière indirecte*).
- **Flou de mouvement**, `src/motionblur.js` : obturateur à 1/48 s. La vitesse des billes est exacte (tirée de leur
  trajectoire), celle des autres pièces et de la caméra vient de l'image précédente. Coupé en pause, sur un saut dans
  le morceau et sur une coupe franche. En qualité moyenne et basse, des fantômes lumineux suivent les billes.
- **Caméra** : un objectif par type de plan (gros plan 30°, travelling 35°, dialogue 34°, contre-plongée 48°, les
  autres 40°), la caméra reculant d'autant pour garder le cadrage ; profondeur de champ où les points lumineux
  forment des disques ; mise au point qui glisse d'un sujet à l'autre.
- **Matériaux** physiques (laque sous vernis, fonte peinte, métal brossé, verre, bois débité sur dosse, peaux
  marquées par les frappes) à textures procédurales, aucun fichier image. Un **grain de surface** partagé (relief
  fin, poli inégal) est projeté dans le repère de chaque pièce.
- **Effets** : étincelles d'impact des billes (déterministes : identiques à chaque passage), éclair de bouche des
  canons, poussières en suspension.
- **Post-traitement**, `src/postfx.js` : rendu HDR anticrénelé (MSAA 4×) résolu une seule fois, puis lumière
  indirecte, flou de mouvement, profondeur de champ, faisceaux, halo, et une dernière passe (vignettage, courbe AgX,
  étalonnage, sRVB, grain). En qualité basse : rendu direct, courbe ACES.

## Import audio (mp3 → animation)

1. **Notes** : [Basic Pitch](https://github.com/spotify/basic-pitch) (Spotify, Apache-2.0), réseau de neurones léger
   exécuté avec TensorFlow.js (chargé seulement à l'import d'un fichier audio, modèle servi dans `public/models/`).
2. **Batterie** (`src/drumDetect.js`, dans un Web Worker) : spectrogramme, séparation harmonique / percussive (HPSS,
   filtres médians), puis montées d'énergie par bande — grave → grosse caisse, 180-3000 Hz → caisse claire,
   5-11 kHz → charleston. Si l'aigu ne contient presque pas d'énergie percussive (piano, cordes…), on conclut à
   l'absence de batterie.
3. **Répartition** (`src/audioArrange.js`) : la note la plus grave de chaque attaque, sous un seuil relatif au morceau,
   va à la basse ; les notes longues à l'orgue ; le reste aux billes (polyphonie limitée).
4. **Lecture** de l'enregistrement original, calé sur le transport (pause, saut et vidéo suivent).

Précision mesurée par `tools/audio-bench.cjs` sur des rendus FluidSynth dont la partition est connue (F1, attaque à
± 50 ms) : notes à la hauteur exacte 50-85 % selon les morceaux (piano seul ≈ 85 %, mix dense ≈ 50 %), basse 30-65 %,
grosse caisse ≈ 90 %, caisse claire ≈ 93 %, charleston 60-80 %, aucun coup fantôme sur piano ou cordes seuls.
C'est fait pour animer, pas pour obtenir une partition : on entend toujours le vrai morceau.

## Synchro image / son

L'image est calée sur l'échantillon **réellement en train de sortir des haut-parleurs**
(`AudioContext.getOutputTimestamp()`, à défaut `currentTime − outputLatency`), et non sur l'horloge de
programmation de Tone.js qui a ~0,1 s d'avance. Pendant un enregistrement vidéo, le son étant capté à la source,
l'image suit l'horloge de rendu audio.

En lecture, l'image est en outre dessinée **en avance d'un intervalle d'image** (mesuré et lissé, 50 ms au plus) :
une image calculée maintenant n'apparaît qu'au rafraîchissement suivant, et ce retard grandit quand la cadence baisse.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/midi.js` | Lecture MIDI (`@tonejs/midi`) → pistes / notes / programme ; morceau de démo |
| `src/arranger.js` | Rôle de chaque piste (programme GM + statistiques + passe globale), construction et placement des instruments |
| `src/choreography.js`, `src/drums.js`, `src/strings.js`, `src/pipes.js`, `src/bells.js`, `src/laser.js`, `src/bowed.js`, `src/winds.js`, `src/keys.js` | **Cœurs purs, sans Three.js** : mouvements calculés de chaque instrument |
| `src/sections.js` | **Pur** : sections du morceau, déploiement des instruments, ambiance à l'instant t |
| `src/director.js` | **Pur** : plans caméra et pose de la caméra (et mise au point) à l'instant t |
| `src/*View.js` | Rendu Three.js de chaque instrument |
| `src/scene.js` | Scène, qualité ; instancie la vue de chaque instrument |
| `src/environment.js` | Décor : conque, gril et pont, plancher réfléchissant, éclairage et poursuites, poussières |
| `src/postfx.js` | Post-traitement : rendu HDR, profondeur de champ, halo, passe finale (AgX, étalonnage) |
| `src/ssgi.js` | Tampon géométrique (normales, couleur, vitesse), lumière indirecte et occlusion ambiante |
| `src/motionblur.js`, `src/volumetric.js` | Flou de mouvement ; faisceaux des projecteurs dans la brume |
| `src/materials.js`, `src/parts.js` | Matériaux physiques, textures procédurales, pièces de construction partagées |
| `src/audio.js` | Tone.js : horloge de référence, synthèse de secours, capture pour la vidéo |
| `src/soundfont.js`, `src/synthEvents.js` | Lecteur SoundFont (SpessaSynth) piloté par le transport Tone : un canal MIDI par piste |
| `src/exporter.js` | Export glTF (animation cuite) |
| `src/audioImport.js`, `src/transcribe.js`, `src/drumDetect.js`, `src/audioArrange.js` | Import d'un enregistrement : décodage, transcription, batterie, répartition |
| `src/main.js` | Interface et boucle de rendu |

Outils : `tools/gm-attack.mjs` (table des temps d'attaque de la banque, `src/gmAttack.js`), `tools/bench.mjs`, `tools/collide.mjs`,
`tools/smoke.mjs`, `tools/shot.mjs` (captures d'écran à un instant donné), `tools/stress-midi.mjs` (fichiers MIDI de stress), `tools/audio-bench.cjs` (précision de l'import
audio : `node tools/audio-bench.cjs morceau.mp3` à côté de `morceau.mid`, ffmpeg requis).

## Export vers Blender

*Fichier → Importer → glTF 2.0* puis choisir le `.glb`. On y trouve tous les instruments (noms préfixés
`billes_`, `batterie_`, `basse_`, `orgue_`, `carillon_`, `harpe_laser_`, `cordes_frottees_`, `vents_`, `cordes_pincees_`, `clavier_`, `bille_pisteN_k`) et la caméra animée `camera_realisateur`
(à définir comme caméra active). L'animation est échantillonnée à 30 img/s ; le décalage du son par rapport au
début de l'animation est indiqué dans le message d'export et dans les propriétés personnalisées de la racine
(`animusic.decalageAudioSecondes`). Non exportés : décor (sol, fond, projecteurs), lumières et effets lumineux
(émission animée, rayons laser, traînées, étincelles : non standard en glTF) — à recréer dans Blender.

## Sons et modèles

La banque `public/soundfonts/MuseScore_General.sf3` (MuseScore General, dérivée de *Fluid (R3) General MIDI*
de Frank Wen) est sous licence MIT (voir `public/soundfonts/LICENSE.md`). Le lecteur SoundFont est SpessaSynth,
sous licence Apache-2.0. Le modèle de transcription de `public/models/basic-pitch/` est celui de Basic Pitch
(Spotify), sous licence Apache-2.0.

## Déploiement

`.github/workflows/deploy.yml` teste, construit, lance le test de fumée dans Chromium, puis publie sur GitHub Pages
à chaque push sur la branche par défaut.
