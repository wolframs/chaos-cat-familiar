(function () {
  function createFrameTimeline(host, onSelect) {
    const strip = document.createElement('div');
    strip.className = 'frame-strip';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'Individual frames');
    host.appendChild(strip);
    let frames = [], buttons = [], drawFrame = null, active = -1;

    function setFrames(nextFrames, draw) {
      frames = nextFrames;
      drawFrame = draw;
      buttons = frames.map((frame, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'frame-tile';
        button.setAttribute('aria-label', `Frame ${index + 1}: ${frame.label}; ${frame.detail}`);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 96;
        const title = document.createElement('strong');
        title.textContent = `${index + 1}. ${frame.label}`;
        const detail = document.createElement('small');
        detail.textContent = frame.detail;
        button.append(canvas, title, detail);
        button.onclick = () => onSelect(index, frame);
        drawFrame(canvas, frame, index);
        return button;
      });
      strip.replaceChildren(...buttons);
      active = -1;
    }

    function setActive(index) {
      if (active === index) return;
      if (buttons[active]) {
        buttons[active].classList.remove('active');
        buttons[active].removeAttribute('aria-current');
      }
      active = index;
      const button = buttons[index];
      if (!button) return;
      button.classList.add('active');
      button.setAttribute('aria-current', 'step');
      if (button.offsetLeft < strip.scrollLeft) strip.scrollLeft = button.offsetLeft;
      else if (button.offsetLeft + button.offsetWidth > strip.scrollLeft + strip.clientWidth)
        strip.scrollLeft = button.offsetLeft + button.offsetWidth - strip.clientWidth;
    }

    function redraw() {
      if (!drawFrame) return;
      frames.forEach((frame, index) => drawFrame(buttons[index].querySelector('canvas'), frame, index));
    }

    return { setFrames, setActive, redraw };
  }

  window.createFrameTimeline = createFrameTimeline;
})();
