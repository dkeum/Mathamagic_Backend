const handleNextOrSubmit_solvetab_promptText = `
      You are grading a single math answer. Respond with ONLY valid JSON, no markdown, no extra text.
      Question: ${currentQuestion?.question || ""}
      Correct answer: ${correctAnswer}
      Student's typed answer: ${studentAnswerText || "(none)"}
      ${attachedImageUrl ? "The student also attached an image — look at it as part of their answer." : ""}

      Return: {"is_correct": true or false}
    `;



 const submitAnswers_analysisPrompt = `
            You are an evaluation engine for a math platform. 
            Analyze the following student answers against the questions and determine if they are mathematically correct.
            
            Data to analyze:
            ${JSON.stringify(finalAttempts, null, 2)}
            
            Your task:
            1. Review each item. Verify if "answer_given" matches the mathematically correct solution for that question.
            2. Set "is_correct" strictly to true or false based on your evaluation.
            3. Return ONLY a valid JSON array containing objects with at least "question_id" and "is_correct".
            Do not include any markdown formatting, backticks, or extra text.
          `;

      const response = await window.puter.ai.chat(analysisPrompt, {
        json_mode: true,
      });
