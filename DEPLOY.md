# Nasazení na https://hlubocek.github.io

Aby aplikace běžela na této adrese, musí být na GitHubu **organizace** nebo **účet** s názvem **hlubocek** a repozitář přesně **hlubocek.github.io**.

## Kroky

### 1. Vytvořit organizaci na GitHubu (pokud ještě nemáte)
- GitHub → **Settings** (váš profil) → **Organizations** → **New organization**
- Název: **hlubocek**
- Free plan stačí

### 2. Vytvořit repozitář
- V organizaci **hlubocek** (nebo na svém účtu): **New repository**
- **Repository name** musí být přesně: **hlubocek.github.io**
- Veřejný (Public), bez README (projekt už máte lokálně)

### 3. Zapnout GitHub Pages
- V repozitáři **hlubocek.github.io** → **Settings** → v levém menu **Pages**
- **Source**: Deploy from a branch
- **Branch**: `main` (nebo `master`), složka **/ (root)**
- **Save**

### 4. Nahrát projekt do repozitáře
V terminálu ve složce projektu (`rybari-registrace`):

```bash
git remote add origin https://github.com/hlubocek/hlubocek.github.io.git
git branch -M main
git push -u origin main
```

(Pokud jste repozitář už měli napojený pod jiným názvem, přepněte remote:  
`git remote set-url origin https://github.com/hlubocek/hlubocek.github.io.git`  
a pak `git push -u origin main`.)

### 5. Počkat 1–2 minuty
GitHub Pages stránku sestaví. Pak by měla aplikace běžet na **https://hlubocek.github.io**.

---

**Důležité:** V kořenu repozitáře musí být soubory `index.html`, `app.js`, `style.css`. Pokud je máte v podsložce, nahrajte obsah té podsložky do **kořene** repozitáře (ne celou složku `rybari-registrace` jako jednu složku).
