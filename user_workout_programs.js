const USER_WORKOUT_PROGRAMS = {
    powerlifting_and_strength: {
        male: {
            intermediate: {
                title: "Пауэрлифтинг и силовые, мужчина, средняя нагрузка (Неделя 1-7)",
                description: "7-недельная программа, направленная на увеличение силовых показателей в базовых движениях.",
                weeks: [
                    // Week 1
                    {
                        week: 1,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "4x5", weight: "52,5" }, { name: "Гориз.тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Жим стоя", sets_reps: "3x8", weight: "40" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "средне" }, { name: "Трицепс", sets_reps: "2x8-12" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "4x5", weight: "40" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Ст. тяга", sets_reps: "4x5", weight: "45" }, { name: "Пресс", sets_reps: "3x8-12", weight: "средне" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "4x5", weight: "45" }, { name: "Верт.тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "средне" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "4x5", weight: "50" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Присед", sets_reps: "3x8", weight: "35" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    },
                    // Week 2
                    {
                        week: 2,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "4x5", weight: "55" }, { name: "Гориз.тяга", sets_reps: "3x8-12", weight: "тяжело" }, { name: "Жим стоя", sets_reps: "3x8", weight: "40" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "тяжело" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "4x5", weight: "42,5" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Ст. тяга", sets_reps: "4x5", weight: "45" }, { name: "Пресс", sets_reps: "3x8-12", weight: "тяжело" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "4x5", weight: "47,5" }, { name: "Верт.тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "средне" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "4x5", weight: "52,5" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Присед", sets_reps: "3x8", weight: "35" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    },
                    // Week 3
                    {
                        week: 3,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "4x5", weight: "57,5" }, { name: "Гориз.тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Жим стоя", sets_reps: "3x8", weight: "40" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "средне" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "средне" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "4x5", weight: "45" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "тяжело" }, { name: "Ст. тяга", sets_reps: "3x6-10", weight: "легко" }, { name: "Пресс", sets_reps: "3x8-12", weight: "средне" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "4x5", weight: "50" }, { name: "Верт.тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "4x5", weight: "55" }, { name: "Лицевая тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Присед", sets_reps: "3x8", weight: "35" }, { name: "Пресс", sets_reps: "2x8-12", weight: "средне" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "средне" }] }
                        ]
                    },
                    // Week 4
                    {
                        week: 4,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "4x5", weight: "60" }, { name: "Гориз.тяга", sets_reps: "3x6-8", weight: "легко" }, { name: "Жим стоя", sets_reps: "4x5", weight: "45" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "4x5", weight: "47,5" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Ст. тяга", sets_reps: "3x8-12", weight: "тяжело" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "4x5", weight: "52,5" }, { name: "Верт.тяга", sets_reps: "3x6-8", weight: "тяжело" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "4x5", weight: "57,5" }, { name: "Лицевая тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Присед", sets_reps: "4x5", weight: "40" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    },
                     // Week 5
                    {
                        week: 5,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "4x5", weight: "62,5" }, { name: "Гориз.тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Жим стоя", sets_reps: "4x5", weight: "45" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "4x5", weight: "50" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Ст. тяга", sets_reps: "4x4", weight: "50" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "4x5", weight: "55" }, { name: "Верт.тяга", sets_reps: "3x8-12", weight: "средне" }, { name: "Жим лежа", sets_reps: "3x8", weight: "50" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "4x5", weight: "60" }, { name: "Лицевая тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Присед", sets_reps: "4x5", weight: "40" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    },
                    // Week 6
                    {
                        week: 6,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "3x3", weight: "65" }, { name: "Гориз.тяга", sets_reps: "3x6-8", weight: "легко" }, { name: "Жим стоя", sets_reps: "4x5", weight: "45" }, { name: "Верт.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "3x3", weight: "52,5" }, { name: "Лицевая тяга", sets_reps: "3x8-12", weight: "легко" }, { name: "Ст. тяга", sets_reps: "4x4", weight: "50" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "3x3", weight: "57,5" }, { name: "Верт.тяга", sets_reps: "3x6-8", weight: "тяжело" }, { name: "Жим лежа", sets_reps: "3x8", weight: "50" }, { name: "Гориз.тяга", sets_reps: "2x8-12", weight: "легко" }, { name: "Трицепс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "3x3", weight: "62,5" }, { name: "Лицевая тяга", sets_reps: "2x12-20", weight: "легко" }, { name: "Присед", sets_reps: "4x5", weight: "40" }, { name: "Пресс", sets_reps: "3x8-12", weight: "средне" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    },
                    // Week 7
                    {
                        week: 7,
                        days: [
                            { title: "День 1", exercises: [{ name: "Жим лежа", sets_reps: "2x2", weight: "67,5" }, { name: "Гориз.тяга", sets_reps: "2x5-7", weight: "легко" }, { name: "Жим стоя", sets_reps: "4x5", weight: "45" }, { name: "Верт.тяга", sets_reps: "2x6-8", weight: "легко" }, { name: "Трицепс", sets_reps: "2x6-8", weight: "легко" }] },
                            { title: "День 2", exercises: [{ name: "Присед", sets_reps: "2x2", weight: "55" }, { name: "Лицевая тяга", sets_reps: "2x12-15", weight: "легко" }, { name: "Ст. тяга", sets_reps: "4x5", weight: "52,5" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }] },
                            { title: "День 3", exercises: [{ name: "Жим стоя", sets_reps: "2x2", weight: "60" }, { name: "Верт.тяга", sets_reps: "2x5-7", weight: "легко" }, { name: "Жим лежа", sets_reps: "3x3", weight: "50" }, { name: "Трицепс", sets_reps: "2x6-8", weight: "легко" }] },
                            { title: "День 4", exercises: [{ name: "Ст. тяга", sets_reps: "2x2", weight: "65" }, { name: "Лицевая тяга", sets_reps: "2x12-15", weight: "легко" }, { name: "Присед", sets_reps: "3x3", weight: "42,5" }, { name: "Пресс", sets_reps: "2x8-12", weight: "легко" }, { name: "Бицепс", sets_reps: "2x8-12", weight: "легко" }] }
                        ]
                    }
                ]
            },
            advanced: {
                title: "Пауэрлифтинг и силовые, мужчина, большая нагрузка",
                description: "Программы, разделенные на блоки, с фокусом на интенсивности и вариативности.",
                blocks: [
                    {
                        block: 1,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "средняя", sets_reps: "3x6-8" }, { name: "жим гантелей", intensity: "средняя", sets_reps: "3x8-12" }, { name: "ягодичный мс", intensity: "легкая", sets_reps: "3x6-8" }, { name: "отведения на", intensity: "легкая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "3x8-12" }, { name: "тяга вертикал", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем ганте", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский", intensity: "легкая", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 2,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "ягодичный мс", intensity: "легкая", sets_reps: "3x6-8" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "тяга вертикал", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "подъем ганте", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский", intensity: "легкая", sets_reps: "3x8-12" }] }
                        ]
                    },
                     {
                        block: 3,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "легкая", sets_reps: "3x6-8" }, { name: "жим гантелей", intensity: "легкая", sets_reps: "3x8-12" }, { name: "разгибания н", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "тяга вертикал", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем ez гр", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "тяжёлая", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 4,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "средняя", sets_reps: "3x8-12" }, { name: "отведения на", intensity: "средняя", sets_reps: "3x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжёлая", sets_reps: "4x8-13" }, { name: "тяга вертикал", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "подъем ez гр", intensity: "средняя", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "средняя", sets_reps: "3x8-12" }] }
                        ]
                    }
                ],
                week_7: {
                    title: "Неделя 7 (специализированная)",
                    days: [
                        { title: "День 1", exercises: [{ name: "Становая тяга", sets_reps: "2x2", weight: "205,0 т" }, { name: "Жим лежа", sets_reps: "3x3", weight: "82,5 л" }, { name: "Кликни чтобы выбрать доп. тягу", sets_reps: "2x3", weight: "RPE: 5" }] },
                        { title: "День 2", exercises: [{ name: "Жим лежа", sets_reps: "2x2", weight: "112,5 т" }, { name: "Приседания", sets_reps: "3x3", weight: "120,0 л" }, { name: "Кликни чтобы выбрать доп. г/жим", sets_reps: "2x3", weight: "RPE: 5" }] },
                        { title: "День 3", exercises: [{ name: "Приседания", sets_reps: "2x2", weight: "155,0 т" }, { name: "Становая тяга", sets_reps: "3x3", weight: "157,5 л" }, { name: "Кликни чтобы выбрать доп. присед", sets_reps: "2x3", weight: "RPE: 5" }] }
                    ]
                }
            }
        }
    },
    bodybuilding: {
        male: {
            beginner: {
                title: "Бодибилдинг, мужчина, малая нагрузка",
                description: "8-блоковая программа для начинающих, нацеленная на гипертрофию.",
                blocks: [
                    {
                        block: 1,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами с", intensity: "средняя", sets_reps: "3x6-8" }, { name: "жим гантелей", intensity: "средняя", sets_reps: "3x8-12" }, { name: "ягодичный мс", intensity: "легкая", sets_reps: "3x6-8" }, { name: "отведения на", intensity: "легкая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "3x8-12" }, { name: "тяга вертикал", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем ганте", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский", intensity: "легкая", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 2,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "ягодичный мс", intensity: "легкая", sets_reps: "3x6-8" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "тяга вертикал", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "подъем ганте", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский", intensity: "легкая", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 3,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "легкая", sets_reps: "3x6-8" }, { name: "жим гантелей", intensity: "легкая", sets_reps: "3x8-12" }, { name: "разгибания н", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "тяга вертикал", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем ez гр", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "тяжёлая", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 4,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "средняя", sets_reps: "3x8-12" }, { name: "отведения на", intensity: "средняя", sets_reps: "3x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжёлая", sets_reps: "4x8-13" }, { name: "тяга вертикал", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "подъем ez гр", intensity: "средняя", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "средняя", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 5,
                        trainings: [
                           { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "легкая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "легкая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "3x8-12" }] },
                           { title: "Тренировка 2", exercises: [{ name: "жим лёжа 30°", intensity: "легкая", sets_reps: "4x8-12" }, { name: "тяга горизонт", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем ez гр", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "тяжёлая", sets_reps: "3x8-12" }] }
                        ]
                   },
                   {
                        block: 6,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "средняя", sets_reps: "3x8-12" }, { name: "отведения на", intensity: "средняя", sets_reps: "3x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа 30°", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "тяга горизонт", intensity: "тяжёлая", sets_reps: "3x8-12" }, { name: "подъем ez гр", intensity: "средняя", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "средняя", sets_reps: "3x8-12" }] }
                        ]
                    },
                    {
                        block: 7,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "тяжёлая", sets_reps: "5x8-12" }, { name: "отведения на", intensity: "тяжёлая", sets_reps: "4x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа 30°", intensity: "средняя", sets_reps: "5x8-12" }, { name: "тяга горизонт", intensity: "средняя", sets_reps: "5x8-12" }, { name: "подъем ez гр", intensity: "тяжёлая", sets_reps: "5x8-12" }, { name: "разгибания р", intensity: "средняя", sets_reps: "4x8-12" }] }
                        ]
                    },
                    {
                        block: 8,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами", intensity: "тяжёлая", sets_reps: "4x6-8" }, { name: "жим гантелей;", intensity: "тяжёлая", sets_reps: "4x8-12" }, { name: "разгибания н", intensity: "средняя", sets_reps: "3x8-12" }, { name: "отведения на", intensity: "средняя", sets_reps: "3x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа 30°", intensity: "тяжёлая", sets_reps: "5x8-12" }, { name: "тяга горизонт", intensity: "тяжёлая", sets_reps: "5x8-12" }, { name: "подъем ez гр", intensity: "средняя", sets_reps: "4x8-12" }, { name: "разгибания р", intensity: "средняя", sets_reps: "3x8-12" }] }
                        ]
                    }
                ]
            },
            intermediate: { 
                title: "Бодибилдинг, мужчина, средняя нагрузка",
                description: "Программа на 6 блоков для опытных атлетов.",
                blocks: [
                    {
                        block: 1,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "средняя", sets_reps: "4x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "3x8-12" }, { name: "жим гантелей сидя", intensity: "легкая", sets_reps: "3x8-12" }, { name: "сгибания кисти со штангой", intensity: "легкая", sets_reps: "4x8-12" }, { name: "подъем на носки в смите", intensity: "легкая", sets_reps: "4x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "4x8-12" }, { name: "тяга вертикального блока", intensity: "средняя", sets_reps: "3x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем гантелей на бицепс", intensity: "легкая", sets_reps: "4x8-12" }, { name: "подъем на носки в смите", intensity: "средняя", sets_reps: "4x12-15" }] }
                        ]
                    },
                    {
                        block: 2,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "жим гантелей сидя", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "4x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "тяга вертикального блока", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "французский жим лежа", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "подъем гантелей на бицепс", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 3,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "легкая", sets_reps: "3x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "3x8-12" }, { name: "жим гантелей сидя", intensity: "легкая", sets_reps: "3x8-12" }, { name: "сгибания кисти со штангой", intensity: "легкая", sets_reps: "5x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "молотки", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "легкая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "тяга вертикального блока", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский жим лежа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "легкая", sets_reps: "5x8-12" }, { name: "молотки", intensity: "легкая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "легкая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 4,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "жим гантелей сидя", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "средняя", sets_reps: "3x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "5x8-13" }, { name: "тяга вертикального блока", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "средняя", sets_reps: "3x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 5,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "жим гантелей сидя", intensity: "вс легкая", sets_reps: "4x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "вс легкая", sets_reps: "4x8-12" }, { name: "тяга вертикального блока", intensity: "вс легкая", sets_reps: "4x8-12" }, { name: "французский жим лежа", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 6,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "6x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "жим гантелей сидя", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "6x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "тяга вертикального блока", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "французский жим лежа", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "подъем ez грифа на бицепс", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "3x8-12" }, { name: "подъем на носки в смите", intensity: "тяжелая", sets_reps: "6x12-15" }] }
                        ]
                    }
                ]
            },
            advanced: {
                title: "Бодибилдинг, мужчина, высокая нагрузка",
                description: "8-блоковая программа для максимальной гипертрофии.",
                blocks: [
                    {
                        block: 1,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "средняя", sets_reps: "4x6-8" }, { name: "жим гантелей сидя", intensity: "средняя", sets_reps: "4x8-12" }, { name: "отведения на дельты", intensity: "средняя", sets_reps: "4x8-12" }, { name: "сгибания кисти со штангой", intensity: "средняя", sets_reps: "4x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "4x8-12" }, { name: "тяга горизонтального бло", intensity: "средняя", sets_reps: "5x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "5x8-12" }, { name: "подъем на бицепс в смите", intensity: "средняя", sets_reps: "5x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "4x8-12" }] }
                        ]
                    },
                    {
                        block: 2,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "средняя", sets_reps: "4x6-8" }, { name: "жим гантелей сидя", intensity: "средняя", sets_reps: "4x8-12" }, { name: "отведения на дельты", intensity: "средняя", sets_reps: "4x8-12" }, { name: "сгибания кисти со штангой", intensity: "средняя", sets_reps: "4x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "4x8-12" }, { name: "тяга горизонтального бло", intensity: "средняя", sets_reps: "5x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "5x8-12" }, { name: "подъем на бицепс в смите", intensity: "средняя", sets_reps: "5x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "4x8-12" }] }
                        ]
                    },
                    {
                        block: 3,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "жим гантелей сидя", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "5x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "тяга горизонтального бло", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "французский жим лежа", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "подъем на бицепс в смите", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "5x8-12" }] }
                        ]
                    },
                    {
                        block: 4,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "жим гантелей сидя", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "сгибания кисти со штангой", intensity: "тяжелая", sets_reps: "5x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "тяга горизонтального бло", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "французский жим лежа", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "подъем на бицепс в смите", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "молотки", intensity: "тяжелая", sets_reps: "5x8-12" }] }
                        ]
                    },
                    {
                        block: 5,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "вс легкая", sets_reps: "5x6-8" }, { name: "жим гантелей сидя", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "сгибания кисти со штангой", intensity: "вс легкая", sets_reps: "5x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "тяга горизонтального бло", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "французский жим лежа", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "подъем на бицепс в смите", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "молотки", intensity: "вс легкая", sets_reps: "5x8-12" }] }
                        ]
                    },
                    {
                        block: 6,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "вс легкая", sets_reps: "5x6-8" }, { name: "жим гантелей сидя", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "сгибания кисти со штангой", intensity: "вс легкая", sets_reps: "5x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "вс легкая", sets_reps: "5x8-12" }, { name: "тяга горизонтального бло", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "французский жим лежа", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "подъем на бицепс в смите", intensity: "вс легкая", sets_reps: "6x8-12" }, { name: "молотки", intensity: "вс легкая", sets_reps: "5x8-12" }] }
                        ]
                    },
                    {
                        block: 7,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "средняя", sets_reps: "6x6-8" }, { name: "жим гантелей сидя", intensity: "средняя", sets_reps: "6x8-12" }, { name: "отведения на дельты", intensity: "средняя", sets_reps: "6x8-12" }, { name: "сгибания кисти со штангой", intensity: "средняя", sets_reps: "6x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "6x8-12" }, { name: "тяга горизонтального бло", intensity: "средняя", sets_reps: "7x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "7x8-12" }, { name: "подъем на бицепс в смите", intensity: "средняя", sets_reps: "7x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "6x8-12" }] }
                        ]
                    },
                    {
                        block: 8,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим ногами в упоре в н", intensity: "средняя", sets_reps: "6x6-8" }, { name: "жим гантелей сидя", intensity: "средняя", sets_reps: "6x8-12" }, { name: "отведения на дельты", intensity: "средняя", sets_reps: "6x8-12" }, { name: "сгибания кисти со штангой", intensity: "средняя", sets_reps: "6x8-12" }] },
                            { title: "Тренировка 2", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "6x8-12" }, { name: "тяга горизонтального бло", intensity: "средняя", sets_reps: "7x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "7x8-12" }, { name: "подъем на бицепс в смите", intensity: "средняя", sets_reps: "7x8-12" }, { name: "молотки", intensity: "средняя", sets_reps: "6x8-12" }] }
                        ]
                    }
                ]
            }
        },
        female: {
            advanced: {
                title: "Бодибилдинг, женщина, высокая нагрузка",
                description: "8-блоковая программа для женщин, нацеленная на построение фигуры.",
                blocks: [
                    {
                        block: 1,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "средняя", sets_reps: "4x8-12" }, { name: "тяга вертикального блока", intensity: "средняя", sets_reps: "4x8-12" }, { name: "французский жим лежа", intensity: "средняя", sets_reps: "3x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "средняя", sets_reps: "3x8-12" }, { name: "отведения на дельты", intensity: "средняя", sets_reps: "4x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "средняя", sets_reps: "4x6-8" }, { name: "присед", intensity: "средняя", sets_reps: "4x6-8" }, { name: "сгибания ног в тренажере", intensity: "средняя", sets_reps: "4x8-12" }, { name: "румынская тяга", intensity: "средняя", sets_reps: "4x8-12" }, { name: "сгибания ног в смите", intensity: "средняя", sets_reps: "4x12-15" }] }
                        ]
                    },
                    {
                        block: 2,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "тяга вертикального блока", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "французский жим из-за головы в бл", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "присед", intensity: "тяжелая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "румынская тяга", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "сгибания ног в смите", intensity: "тяжелая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 3,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "тяга вертикального блока", intensity: "легкая", sets_reps: "3x8-12" }, { name: "французский жим лежа", intensity: "легкая", sets_reps: "3x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "легкая", sets_reps: "3x8-12" }, { name: "отведения на дельты", intensity: "легкая", sets_reps: "3x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "легкая", sets_reps: "3x6-8" }, { name: "присед", intensity: "легкая", sets_reps: "3x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "3x8-12" }, { name: "румынская тяга", intensity: "легкая", sets_reps: "3x8-12" }, { name: "сгибания ног в смите", intensity: "легкая", sets_reps: "3x12-15" }] }
                        ]
                    },
                    {
                        block: 4,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа 30°", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "французский жим из-за головы в бл", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "4x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "тяжелая", sets_reps: "4x6-8" }, { name: "присед", intensity: "тяжелая", sets_reps: "4x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "румынская тяга", intensity: "тяжелая", sets_reps: "4x8-12" }, { name: "сгибания ног в смите", intensity: "тяжелая", sets_reps: "4x12-15" }] }
                        ]
                    },
                    {
                        block: 5,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "5x8-12" }, { name: "тяга вертикального блока", intensity: "легкая", sets_reps: "5x8-12" }, { name: "французский жим из-за головы в бл", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "легкая", sets_reps: "5x6-8" }, { name: "присед", intensity: "легкая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "5x8-12" }, { name: "румынская тяга", intensity: "легкая", sets_reps: "5x8-12" }, { name: "сгибания ног в смите", intensity: "легкая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 6,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа 30°", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "французский жим из-за головы в бл", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "тяжелая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "тяжелая", sets_reps: "6x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "тяжелая", sets_reps: "6x6-8" }, { name: "присед", intensity: "тяжелая", sets_reps: "6x6-8" }, { name: "сгибания ног в тренажере", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "румынская тяга", intensity: "тяжелая", sets_reps: "6x8-12" }, { name: "сгибания ног в смите", intensity: "тяжелая", sets_reps: "6x12-15" }] }
                        ]
                    },
                    {
                        block: 7,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "5x8-12" }, { name: "тяга вертикального блока", intensity: "легкая", sets_reps: "5x8-12" }, { name: "французский жим из-за головы в бл", intensity: "легкая", sets_reps: "5x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "легкая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "легкая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "легкая", sets_reps: "5x6-8" }, { name: "присед", intensity: "легкая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "5x8-12" }, { name: "румынская тяга", intensity: "легкая", sets_reps: "5x8-12" }, { name: "сгибания ног в смите", intensity: "легкая", sets_reps: "5x12-15" }] }
                        ]
                    },
                    {
                        block: 8,
                        trainings: [
                            { title: "Тренировка 1", exercises: [{ name: "жим лёжа", intensity: "легкая", sets_reps: "5x8-12" }, { name: "тяга вертикального блока", intensity: "легкая", sets_reps: "5x8-12" }, { name: "французский жим из-за головы в бл", intensity: "легкая", sets_reps: "5x8-12" }, { name: "сгибания на бицепс с супинацией", intensity: "легкая", sets_reps: "5x8-12" }, { name: "отведения на дельты", intensity: "легкая", sets_reps: "5x12-15" }] },
                            { title: "Тренировка 2", exercises: [{ name: "ягодичный мост", intensity: "легкая", sets_reps: "5x6-8" }, { name: "присед", intensity: "легкая", sets_reps: "5x6-8" }, { name: "сгибания ног в тренажере", intensity: "легкая", sets_reps: "5x8-12" }, { name: "румынская тяга", intensity: "легкая", sets_reps: "5x8-12" }, { name: "сгибания ног в смите", intensity: "легкая", sets_reps: "5x12-15" }] }
                        ]
                    }
                ]
            }
        }
    }
};

module.exports = { USER_WORKOUT_PROGRAMS }; 