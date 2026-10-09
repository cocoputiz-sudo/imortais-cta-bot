"use strict";

// A mensagem com imagem deve existir antes da thread, para manter a ordem
// visual no canal do Discord. Após a criação da thread, adiciona-se seu link
// editando a mensagem original, sem enviar outro anúncio ou repetir o ping.
async function publishBeforeThread({ publish, createThread, updateAnnouncement, onUpdateFailure }) {
  const announcement = await publish();
  if (!announcement || typeof announcement.edit !== "function") {
    throw new Error("Falha ao publicar o anúncio do CTA.");
  }

  const thread = await createThread();
  try {
    await updateAnnouncement(announcement, thread);
  } catch (error) {
    if (typeof onUpdateFailure === "function") onUpdateFailure(error);
  }
  return thread;
}

module.exports = { publishBeforeThread };
